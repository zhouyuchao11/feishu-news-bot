#!/usr/bin/env node
/**
 * 飞书每日资讯推送
 * 抓取 3 个领域 RSS → 翻译成中文 → 发送飞书消息
 */

const https = require('https')
const http = require('http')

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK

// ── RSS 源配置 ────────────────────────────────────────────
// lang: 'zh' 表示已是中文，跳过翻译；'en' 表示需要翻译
const RSS_SOURCES = [
  {
    category: '🚗 汽车行业动态',
    feeds: [
      // Google News 中文搜索（国内外新能源资讯）
      { url: 'https://news.google.com/rss/search?q=%E6%96%B0%E8%83%BD%E6%BA%90%E6%B1%BD%E8%BD%A6&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', lang: 'zh' },
      { url: 'https://news.google.com/rss/search?q=%E6%AF%94%E4%BA%9A%E8%BF%AA+OR+%E7%90%86%E6%83%B3+OR+%E8%94%9A%E6%9D%A5+OR+%E5%B0%8F%E9%B9%8F&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', lang: 'zh' },
      // 国际新能源媒体
      { url: 'https://electrek.co/feed/', lang: 'en' },
      { url: 'https://insideevs.com/feed/', lang: 'en' },
    ],
  },
  {
    category: '🎨 品牌形象设计',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=%E5%93%81%E7%89%8C%E8%AE%BE%E8%AE%A1+OR+VI%E8%AE%BE%E8%AE%A1&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', lang: 'zh' },
      { url: 'https://www.dezeen.com/feed/', lang: 'en' },
      { url: 'https://www.underconsideration.com/brandnew/feed/', lang: 'en' },
    ],
  },
  {
    category: '🤖 AI 动态',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD+OR+%E5%A4%A7%E6%A8%A1%E5%9E%8B&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', lang: 'zh' },
      { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
      { url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', lang: 'en' },
    ],
  },
]

// ── 工具函数 ──────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' } }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve)
        return
      }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
  })
}

// 使用 MyMemory 免费翻译 API（无需 key，每天 5000 字符）
function translate(text) {
  if (!text) return Promise.resolve('')
  const encoded = encodeURIComponent(text.slice(0, 200))
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh`
  return new Promise((resolve) => {
    https.get(url, { timeout: 6000 }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const result = json?.responseData?.translatedText
          // 如果翻译失败或返回原文，直接用原文
          resolve(result && result !== text ? result : text)
        } catch {
          resolve(text)
        }
      })
    }).on('error', () => resolve(text)).on('timeout', () => resolve(text))
  })
}

function stripHtml(str) {
  if (!str) return ''
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')  // 解包 CDATA
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')    // 先解码实体
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')                        // 再去掉 HTML 标签
    .replace(/&nbsp;/g, ' ').replace(/&bull;/g, '·').replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim()
}

function parseRSS(xml, maxItems = 10) {
  const items = []
  const itemMatches = xml.matchAll(/<item[\s\S]*?<\/item>/gi)
  for (const match of itemMatches) {
    if (items.length >= maxItems) break
    const block = match[0]

    const title = stripHtml(
      (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
       block.match(/<title[^>]*>([\s\S]*?)<\/title>/))?.[1]
    )

    // Google News 的真实文章链接藏在 description 的 <a href=""> 里
    const descRaw = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     block.match(/<description[^>]*>([\s\S]*?)<\/description>/))?.[1] || ''
    const descDecoded = descRaw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    const articleLink = descDecoded.match(/href="([^"]+)"/)?.[1]
    const fallbackLink = block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim()
    const link = articleLink || fallbackLink

    const desc = stripHtml(descRaw)?.replace(/^.*?·\s*/, '')?.slice(0, 150) || ''

    if (title && link) items.push({ title, link, desc })
  }
  return items
}

async function fetchCategory(category, feeds) {
  const results = []
  for (const feed of feeds) {
    try {
      const url = typeof feed === 'string' ? feed : feed.url
      const lang = typeof feed === 'string' ? 'en' : feed.lang
      const xml = await fetchUrl(url)
      if (!xml) continue
      const items = parseRSS(xml, 10).map(item => ({ ...item, lang }))
      results.push(...items)
      if (results.length >= 10) break
    } catch (_) {}
  }
  return { category, items: results.slice(0, 10) }
}

async function translateSection(section) {
  const translatedItems = []
  for (const item of section.items) {
    if (item.lang === 'zh') {
      // 中文：用 desc 作为概括，没有 desc 就用 title
      const summary = item.desc || item.title
      translatedItems.push({ ...item, summary })
      continue
    }
    // 英文：把 title + desc 合并翻译成一句概括
    const combined = item.desc
      ? `${item.title}. ${item.desc}`
      : item.title
    const summary = await translate(combined)
    translatedItems.push({ ...item, summary })
    await new Promise(r => setTimeout(r, 300))
  }
  return { ...section, items: translatedItems }
}

// ── 构建飞书消息 ──────────────────────────────────────────

function buildFeishuPost(sections) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  })

  const content = []

  content.push([{ tag: 'text', text: `📰  每日资讯  ·  ${today}`, un_escape: true }])
  content.push([{ tag: 'text', text: '─────────────────────', un_escape: true }])

  for (const { category, items } of sections) {
    if (items.length === 0) continue

    content.push([{ tag: 'text', text: '' }])
    content.push([{ tag: 'text', text: category, un_escape: true }])

    for (const item of items) {
      // 一句概括
      content.push([{ tag: 'text', text: `• ${item.summary || item.title}`, un_escape: true }])
      // 查看原文链接
      content.push([{ tag: 'a', text: '  🔗 查看原文', href: item.link }])
      content.push([{ tag: 'text', text: '' }])
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

  console.log('翻译中...')
  const translated = []
  for (const section of sections) {
    const t = await translateSection(section)
    translated.push(t)
  }

  const payload = buildFeishuPost(translated)
  await sendToFeishu(payload)
  console.log('✅ 推送完成')
}

main().catch(err => {
  console.error('❌ 出错:', err)
  process.exit(1)
})
