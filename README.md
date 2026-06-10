# feishu-news-bot

每日自动抓取汽车行业、品牌设计、AI 动态资讯，通过飞书机器人 Webhook 推送。

## 运行时机

- 每天北京时间 **08:30** 自动推送
- 也可在 GitHub Actions 页面手动触发

## 部署步骤

1. 在 GitHub 新建一个仓库，将此项目推送上去
2. 进入仓库 **Settings → Secrets and variables → Actions**
3. 新建 Secret：
   - Name: `FEISHU_WEBHOOK`
   - Value: 你的飞书机器人 Webhook URL（完整 URL，以 `https://open.feishu.cn/open-apis/bot/v2/hook/` 开头）
4. Actions 会在每天 08:30 自动运行

## 本地测试

```bash
FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/your_token" node scripts/daily-news.js
```

## RSS 源

| 类别 | 来源 |
|------|------|
| 汽车行业动态 | 汽车之家、太平洋汽车 |
| 品牌形象设计 | 优设网、站酷 |
| AI 动态 | 机器之心 |
