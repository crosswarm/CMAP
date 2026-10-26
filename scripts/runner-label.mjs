/** runner 的 launchd 服务名：默认 com.cmap.runner（生产在用）；一台主机加入多套服务端时每套用 CMAP_RUNNER_LABEL 区分。 */
export const runnerLabel = (env) => {
  const label = env['CMAP_RUNNER_LABEL']?.trim() || 'com.cmap.runner'
  // 服务名会拼进 ssh 远程命令，不允许 shell 元字符
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(label)) throw new RangeError('CMAP_RUNNER_LABEL 只能含字母、数字与 . _ -')
  return label
}
