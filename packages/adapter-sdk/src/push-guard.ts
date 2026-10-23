/**
 * 信封 permissions.repository 的推送限制（P4-06）：给 Agent 子进程注入 CMAP 管理的 pre-push hook。
 *
 * hooksPath 用命令级配置（GIT_CONFIG_COUNT/KEY/VALUE）注入，优先于仓库自己的 core.hooksPath；
 * hook 在仓库内随代码发布，沙箱对它只读。规则：没有 allow_push_branches 一律拒绝；
 * 推送目标须是 refs/heads/<分支>，匹配某个 allow 模式且不匹配任何 deny 模式（缺省 main、release/*）。
 *
 * 只防失控但非恶意的推送：Agent 可 `git push --no-verify` 或清掉这些环境变量绕过。
 * 硬边界是沙箱（Codex 无网络、两者都不能写工作区外的仓库）与 Agent 拿不到推送凭据，见威胁模型 T1。
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TaskEnvelopeV1 } from '#domain-model'

/** 物理路径：沙箱规则按解析后的路径判定。 */
export const GIT_HOOKS_DIR = realpathSync(fileURLToPath(new URL('../git-hooks', import.meta.url)))

export const pushGuardEnv = (envelope: Pick<TaskEnvelopeV1, 'permissions'>): NodeJS.ProcessEnv => {
  const repo = envelope.permissions.repository
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: GIT_HOOKS_DIR,
    // hook 按空白拆分：含空白的 allow 模式丢弃（拆开会放宽），deny 模式拆开只会更严
    CMAP_PUSH_ALLOW: (repo?.allow_push_branches ?? []).filter((p) => !/\s/.test(p)).join(' '),
    CMAP_PUSH_DENY: (repo?.deny_push ?? ['main', 'release/*']).join(' '),
  }
}
