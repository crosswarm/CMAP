import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskEnvelopeV1 } from "#domain-model";
import { AdapterError } from "#adapter-sdk";
import {
  buildYonWorkPrompt,
  captureYonWorkOutput,
  parseStrictYonWorkOutput,
} from "../../adapters/yonwork-adapter/src/output.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const envelope = (overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 => ({
  schema: "cmap/task-envelope/v1",
  identity: {
    mission_id: "mis-yw",
    task_id: "tsk-yw",
    idempotency_key: "mis-yw:tsk-yw",
    revision: 1,
  },
  classification: {
    task_type: "inspect",
    requested_capability: "yonwork.validate",
    risk_level: "controlled",
  },
  goal: {
    statement: "检查 YonWork 输出",
    success_definition: [
      { criterion_id: "C1", metric: "ok", operator: "eq", expected: true },
    ],
  },
  environment: {},
  execution_policy: { timeout_seconds: 30, max_attempts: 1 },
  permissions: { forbidden: [], yonwork: { chat_send: true } },
  evidence_requirements: { required_artifact_roles: ["report"] },
  output_contract: { schema_uri: "https://cmap.local/schemas/task-result/v1" },
  ...overrides,
});

const finalJson = JSON.stringify({
  status: "completed",
  summary: "ok",
  criterion_results: [{ criterion_id: "C1", actual: "ok", passed: true }],
  findings: [],
  error: null,
});

test("strict YonWork output accepts only schema JSON, no prose or identity fields", async () => {
  assert.equal((await parseStrictYonWorkOutput(finalJson)).summary, "ok");
  await assert.rejects(
    parseStrictYonWorkOutput(`\`\`\`json\n${finalJson}\n\`\`\``),
    (err) => err instanceof AdapterError && err.code === "YONWORK_OUTPUT_NOT_JSON",
  );
  await assert.rejects(
    parseStrictYonWorkOutput(JSON.stringify({ ...JSON.parse(finalJson), task_id: "model-owned" })),
    (err) => err instanceof AdapterError && err.code === "YONWORK_OUTPUT_INVALID",
  );
});

test("captured reply report is fixed, atomic, and normalized with control-owned identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-output-"));
  const result = await captureYonWorkOutput(finalJson, envelope(), dir, "session-1");
  const reportPath = join(dir, "evidence", "yonwork-captured-report.json");
  const bytes = await readFile(reportPath, "utf8");

  assert.deepEqual(JSON.parse(bytes), JSON.parse(finalJson));
  assert.equal(result.mission_id, "mis-yw");
  assert.equal(result.task_id, "tsk-yw");
  assert.equal(result.session?.provider_session_id, "session-1");
  assert.equal(result.artifacts[0]?.role, "report");
  assert.equal(result.artifacts[0]?.uri, "evidence/yonwork-captured-report.json");
  assert.equal(result.artifacts[0]?.sha256, sha256(bytes));

  await captureYonWorkOutput(finalJson, envelope(), dir, "session-1");
  assert.equal((await lstat(reportPath)).isFile(), true);
});

test("captured reply refuses symlink or changed existing report path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-output-"));
  await captureYonWorkOutput(finalJson, envelope(), dir);

  await assert.rejects(
    captureYonWorkOutput(JSON.stringify({ ...JSON.parse(finalJson), summary: "changed" }), envelope(), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_REPORT_EXISTS",
  );

  const linkRoot = await mkdtemp(join(tmpdir(), "cmap-yonwork-output-link-"));
  const outside = join(await mkdtemp(join(tmpdir(), "cmap-yonwork-outside-")), "report.json");
  await writeFile(outside, "{}");
  await symlink(outside, join(linkRoot, "evidence"));
  await assert.rejects(
    captureYonWorkOutput(finalJson, envelope(), linkRoot),
    (err) => err instanceof AdapterError && err.code === "YONWORK_REPORT_PATH_UNSAFE",
  );
});

test("concurrent different captured reports cannot overwrite each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-output-race-"));
  const changed = JSON.stringify({ ...JSON.parse(finalJson), summary: "changed" });
  const settled = await Promise.allSettled([
    captureYonWorkOutput(finalJson, envelope(), dir),
    captureYonWorkOutput(changed, envelope(), dir),
  ]);
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof AdapterError);
  assert.equal((rejected as PromiseRejectedResult).reason.code, "YONWORK_REPORT_EXISTS");
});

test("provider prompt transfers verified text inputs once with stable ordering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-inputs-"));
  await writeFile(join(dir, "b.txt"), "B");
  await writeFile(join(dir, "a.txt"), "A");

  const prompt = await buildYonWorkPrompt(
    envelope({
      inputs: {
        artifact_refs: [
          { artifact_id: "b", role: "source", uri: "b.txt", sha256: sha256("B") },
          { artifact_id: "a", role: "source", uri: "a.txt", sha256: sha256("A") },
        ],
      },
    }),
    dir,
  );

  assert.match(prompt, /artifact_id: a[\s\S]*A[\s\S]*artifact_id: b[\s\S]*B/);
  assert.match(prompt, /"title": "YonWork Output v1"/);
  assert.match(prompt, /"criterion_results"/);
  assert.match(prompt, /"retryable"/);
  assert.doesNotMatch(prompt, /"\$ref"/);
  assert.doesNotMatch(prompt, /write.*file|local file|file:\/\//i);
});

test("provider prompt rejects unsupported context, URLs, missing hash, binary/control, and oversized input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cmap-yonwork-inputs-"));
  await writeFile(join(dir, "bin.dat"), Buffer.from([0xff]));
  await writeFile(join(dir, "nul.txt"), "ok\0bad");
  await writeFile(join(dir, "big.txt"), "x".repeat(32 * 1024 + 1));

  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { context: { repo: "r", ref: "a".repeat(40) } } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_UNSUPPORTED",
  );
  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { artifact_refs: [{ artifact_id: "u", role: "source", uri: "https://example.test/a", sha256: sha256("") }] } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_UNSUPPORTED",
  );
  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { artifact_refs: [{ artifact_id: "m", role: "source", uri: "missing.txt" }] } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_HASH_REQUIRED",
  );
  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { artifact_refs: [{ artifact_id: "bin", role: "source", uri: "bin.dat", sha256: createHash("sha256").update(Buffer.from([0xff])).digest("hex") }] } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_NOT_UTF8",
  );
  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { artifact_refs: [{ artifact_id: "nul", role: "source", uri: "nul.txt", sha256: sha256("ok\0bad") }] } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_BINARY",
  );
  await assert.rejects(
    buildYonWorkPrompt(envelope({ inputs: { artifact_refs: [{ artifact_id: "big", role: "source", uri: "big.txt", sha256: sha256("x".repeat(32 * 1024 + 1)) }] } }), dir),
    (err) => err instanceof AdapterError && err.code === "YONWORK_INPUT_TOO_LARGE",
  );
});
