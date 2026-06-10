#!/usr/bin/env node
/**
 * 飞书每日资讯推送
 * 抓取 3 个领域 RSS → 整理 → 发送飞书消息
 */

const https = require('https')
const http = require('http')

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK

// ── RSS 源配置 ────────────────────────────────────────────
const RSS_SOURCES = [
  {
    category: '🚗 汽车行业动态',
    feeds: [
      'https://www.autohome.com.cn/rss/news.xml',
      'https://www.pcauto.com.cn/rss/news.xml',
    ],
  },
  {
    category: '🎨 品牌形象设计',
    feeds: [
      'https://www.uisdc.com/feed',
      'https://www.zcool.com.cn/feed',
    ],
  },
  {
    category: '🤖 AI 动态',
    feeds: [
      'https://www.jiqizhixin.com/rss',
      'https://feeds.feedburner.com/aitechtrend',
    ],
  },
]

// ── 工具函数 ──────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' } }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
  })
}

function parseRSS(xml, maxItems = 3) {
  const items = []
  const itemMatches = xml.matchAll(/<item[\s\S]*?<\/item>/gi)
  for (const match of itemMatches) {
    if (items.length >= maxItems) break
    const block = match[0]
    const title = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1]?.trim()
    const link  = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/) ||
                   block.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim()
    const desc  = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                   block.match(/<description[^>]*>([\s\S]*?)<\/description>/))?.[1]
                    ?.replace(/<[^>]+>/g, '')
                    ?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
                    ?.trim()
                    ?.slice(0, 80)
    if (title && link) items.push({ title, link, desc })
  }
  return items
}

async function fetchCategory(category, feeds) {
  const results = []
  for (const url of feeds) {
    try {
      const xml = await fetchUrl(url)
      if (!xml) continue
      const items = parseRSS(xml, 3)
      results.push(...items)
      if (results.length >= 3) break
    } catch (_) {}
  }
  return { category, items: results.slice(0, 3) }
}

// ── 构建飞书消息 ──────────────────────────────────────────

function buildFeishuPost(sections) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })

  // 飞书富文本 post 格式
  const content = []

  // 标题行
  content.push([{ tag: 'text', text: `📰  每日资讯  ·  ${today}`, un_escape: true }])
  content.push([{ tag: 'text', text: '─────────────────────', un_escape: true }])

  for (const { category, items } of sections) {
    if (items.length === 0) continue

    // 分类标题
    content.push([{ tag: 'text', text: '' }])
    content.push([{ tag: 'text', text: category, un_escape: true }])

    for (const item of items) {
      // 标题 + 链接
      content.push([
        { tag: 'a', text: `• ${item.title}`, href: item.link },
      ])
      // 摘要（如有）
      if (item.desc) {
        content.push([{ tag: 'text', text: `  ${item.desc}…`, un_escape: true }])
      }
    }
  }

  content.push([{ tag: 'text', text: '' }])
  content.push([{ tag: 'text', text: '─────────────────────', un_escape: true }])
  content.push([{ tag: 'text', text: '由 GitHub Actions 自动推送', un_escape: true }])

  return {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: `每日资讯 · ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })}`,
          content,
        },
      },
    },
  }
}

function sendToFeishu(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const url = new URL(WEBHOOK_URL)
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        console.log('飞书响应:', data)
        resolve(data)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  if (!WEBHOOK_URL) {
    console.error('❌ 缺少 FEISHU_WEBHOOK 环境变量')
    process.exit(1)
  }

  console.log('开始抓取 RSS...')
  const sections = await Promise.all(
    RSS_SOURCES.map(({ category, feeds }) => fetchCategory(category, feeds))
  )

  const hasContent = sections.some(s => s.items.length > 0)
  if (!hasContent) {
    console.warn('⚠️ 所有 RSS 源均无法获取内容，跳过推送')
    return
  }

  sections.forEach(s => console.log(`${s.category}: ${s.items.length} 条`))

  const payload = buildFeishuPost(sections)
  await sendToFeishu(payload)
  console.log('✅ 推送完成')
}

main().catch(err => {
  console.error('❌ 出错:', err)
  process.exit(1)
})
