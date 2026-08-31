# CMAP Ralph Agent Task

实现 `docs/user-stories/cmap-runnable-gaps.json`，直到全部故事通过。

每轮只处理一个 `passes: false` 的故事：先写或确认失败测试，再做最小实现，
运行该故事列出的真实验证；只有证据完整才改成 `passes: true`，追加
`scripts/ralph/log.md` 并提交。外部链路不得用 mock 成功替代。

全部通过后输出 `<promise>FINISHED</promise>`；否则输出 `<promise>CONTINUE</promise>`。
