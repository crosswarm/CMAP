export const parseAdapterNames = (
  value = 'codex',
): readonly ('codex' | 'kimi' | 'yonwork')[] => {
  const names = value.split(',').map((name) => name.trim())
  if (
    names.some((name) => name !== 'codex' && name !== 'kimi' && name !== 'yonwork') ||
    new Set(names).size !== names.length
  ) {
    throw new Error('CMAP_AGENTS 必须为不重复的 codex/kimi/yonwork 列表')
  }
  return names as ('codex' | 'kimi' | 'yonwork')[]
}
