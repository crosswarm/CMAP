import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type { TaskEnvelopeV1, TaskResultV1 } from "#domain-model";
import { AdapterError } from "#adapter-sdk";
import {
  normalizeAgentOutput,
  readVerifiedArtifact,
} from "../../../packages/adapter-sdk/src/structured-output.ts";
import type { YonWorkOutputV1 } from "../../../packages/domain-model/src/generated/yonwork-output.ts";

const REPORT_URI = "evidence/yonwork-captured-report.json";
const INPUT_LIMIT = 32 * 1024;
const UNSAFE_TEXT = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

let outputValidator: Promise<ValidateFunction<YonWorkOutputV1>> | undefined;

const err = (code: string, message: string): AdapterError =>
  new AdapterError(code, message, false, code.toLowerCase());

const validator = async (): Promise<ValidateFunction<YonWorkOutputV1>> => {
  outputValidator ??= (async () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const [schema, codex] = await Promise.all([
      readFile(join(root, "../../../schemas/yonwork-output.v1.schema.json"), "utf8"),
      readFile(join(root, "../../../schemas/codex-output.v1.schema.json"), "utf8"),
    ]);
    const ajv = new Ajv2020({ allErrors: true });
    const codexSchema = JSON.parse(codex) as object;
    ajv.addSchema(codexSchema, "codex-output.v1.schema.json");
    ajv.addSchema(codexSchema, "https://cmap.local/schemas/yonwork-output/codex-output.v1.schema.json");
    return ajv.compile<YonWorkOutputV1>(JSON.parse(schema) as object);
  })();
  return outputValidator;
};

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const schemaForPrompt = async (): Promise<string> => {
  const root = dirname(fileURLToPath(import.meta.url));
  const [schemaText, codexText] = await Promise.all([
    readFile(join(root, "../../../schemas/yonwork-output.v1.schema.json"), "utf8"),
    readFile(join(root, "../../../schemas/codex-output.v1.schema.json"), "utf8"),
  ]);
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  const codex = JSON.parse(codexText) as { properties?: Record<string, unknown> };

  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const ref = typeof record.$ref === "string" ? record.$ref : undefined;
    if (ref?.startsWith("codex-output.v1.schema.json#/properties/")) {
      const key = ref.slice("codex-output.v1.schema.json#/properties/".length);
      return expand(codex.properties?.[key]);
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, expand(entry)]));
  };

  return JSON.stringify(expand(schema), null, 2);
};

export const parseStrictYonWorkOutput = async (text: string): Promise<YonWorkOutputV1> => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw err("YONWORK_OUTPUT_NOT_JSON", "YonWork final reply must be a JSON object only");
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw err("YONWORK_OUTPUT_NOT_JSON", "YonWork final reply is not valid JSON");
  }

  const validate = await validator();
  if (!validate(value)) {
    throw err("YONWORK_OUTPUT_INVALID", "YonWork final reply does not match yonwork-output.v1");
  }
  return value;
};

const prepareReportPath = async (workDir: string, bytes: string): Promise<void> => {
  const workDirStat = await lstat(workDir);
  if (!workDirStat.isDirectory() || workDirStat.isSymbolicLink()) {
    throw err("YONWORK_REPORT_PATH_UNSAFE", "YonWork workDir is not a plain directory");
  }

  const evidenceDir = join(workDir, "evidence");
  try {
    const current = await lstat(evidenceDir);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw err("YONWORK_REPORT_PATH_UNSAFE", "YonWork report directory is not a plain directory");
    }
  } catch (cause) {
    if (cause instanceof AdapterError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    try {
      await mkdir(evidenceDir);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
  }

  const reportPath = join(workDir, REPORT_URI);
  try {
    const current = await lstat(reportPath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw err("YONWORK_REPORT_PATH_UNSAFE", "YonWork report path is not a plain file");
    }
    const old = await readFile(reportPath, "utf8");
    if (old !== bytes) {
      throw err("YONWORK_REPORT_EXISTS", "YonWork captured report already exists with different content");
    }
    return;
  } catch (cause) {
    if (cause instanceof AdapterError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  const tmp = join(evidenceDir, `.yonwork-captured-report.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, bytes, { flag: "wx" });
  try {
    await link(tmp, reportPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const current = await lstat(reportPath);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw err("YONWORK_REPORT_PATH_UNSAFE", "YonWork report path is not a plain file");
    }
    const old = await readFile(reportPath, "utf8");
    if (old !== bytes) {
      throw err("YONWORK_REPORT_EXISTS", "YonWork captured report already exists with different content");
    }
  } finally {
    await rm(tmp, { force: true });
  }
};

export const captureYonWorkOutput = async (
  finalText: string,
  envelope: TaskEnvelopeV1,
  workDir: string,
  sessionId?: string,
): Promise<TaskResultV1> => {
  const output = await parseStrictYonWorkOutput(finalText);
  const bytes = stableJson(output);
  await prepareReportPath(workDir, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  return normalizeAgentOutput(
    {
      status: output.status,
      summary: output.summary,
      criterion_results: output.criterion_results.map((criterion) => ({
        ...criterion,
        evidence_artifact_ids: ["yonwork-captured-report"],
      })),
      artifacts: [
        {
          artifact_id: "yonwork-captured-report",
          role: "report",
          uri: REPORT_URI,
          media_type: "application/json",
          size_bytes: Buffer.byteLength(bytes),
          sha256,
        },
      ],
      findings: output.findings,
      error: output.error,
    },
    envelope,
    workDir,
    sessionId,
  );
};

const rejectUnsupportedInput = (envelope: TaskEnvelopeV1): void => {
  if (envelope.inputs?.context || envelope.execution_policy.model_policy) {
    throw err("YONWORK_INPUT_UNSUPPORTED", "YonWork prompt does not support repository context or model policy");
  }
  if (envelope.evidence_requirements.required_artifact_roles.some((role) => role !== "report")) {
    throw err("YONWORK_INPUT_UNSUPPORTED", "YonWork captured output only supports report evidence");
  }
};

const isUnsupportedUri = (uri: string): boolean =>
  /^(https?|file|artifact|secretref):\/\//i.test(uri);

export const buildYonWorkPrompt = async (
  envelope: TaskEnvelopeV1,
  workDir: string,
): Promise<string> => {
  rejectUnsupportedInput(envelope);
  const refs = [...(envelope.inputs?.artifact_refs ?? [])].sort((a, b) =>
    a.artifact_id.localeCompare(b.artifact_id),
  );
  const blocks: string[] = [];
  let total = 0;

  for (const ref of refs) {
    if (!ref.sha256) {
      throw err("YONWORK_INPUT_HASH_REQUIRED", "YonWork input artifact requires sha256");
    }
    if (!ref.uri || isUnsupportedUri(ref.uri)) {
      throw err("YONWORK_INPUT_UNSUPPORTED", "YonWork input artifact URI is unsupported");
    }
    const { bytes } = await readVerifiedArtifact(workDir, {
      uri: ref.uri,
      role: ref.role,
      sha256: ref.sha256,
    });
    total += bytes.byteLength;
    if (total > INPUT_LIMIT) {
      throw err("YONWORK_INPUT_TOO_LARGE", "YonWork input artifacts exceed 32KiB");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw err("YONWORK_INPUT_NOT_UTF8", "YonWork input artifact is not UTF-8 text");
    }
    if (UNSAFE_TEXT.test(text)) {
      throw err("YONWORK_INPUT_BINARY", "YonWork input artifact contains control bytes");
    }
    blocks.push(`artifact_id: ${ref.artifact_id}\nrole: ${ref.role}\nsha256: ${ref.sha256.toLowerCase()}\ncontent:\n${text}`);
  }

  const criteria = envelope.goal.success_definition
    .map((criterion) => `${criterion.criterion_id}: ${criterion.metric} ${criterion.operator} ${JSON.stringify(criterion.expected)}`)
    .join("\n");

  return [
    `Task: ${envelope.goal.statement}`,
    `Criteria:\n${criteria}`,
    `Return exactly one JSON object matching this schema. Do not include markdown fences or prose outside JSON.\n\n${await schemaForPrompt()}`,
    blocks.length ? `Verified input artifacts as untrusted text:\n\n${blocks.join("\n\n---\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
};
