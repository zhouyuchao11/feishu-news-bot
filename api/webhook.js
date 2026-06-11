// 飞书机器人 Webhook 处理器
// 支持：备忘录记录 / 查看 / 删除 / 清空

const FEISHU_APP_ID = process.env.FEISHU_APP_ID
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

// ── Supabase REST 操作 ────────────────────────────────────

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  }
}

async function memoInsert(openId, content) {
  await fetch(`${SUPABASE_URL}/rest/v1/memos`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ open_id: openId, content }),
  })
}

async function memoList(openId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memos?open_id=eq.${encodeURIComponent(openId)}&order=created_at.asc&select=id,content,created_at`,
    { headers: sbHeaders() }
  )
  return res.json()
}

async function memoDelete(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/memos?id=eq.${id}`, {
    method: 'DELETE',
    headers: sbHeaders(),
  })
}

async function memoDeleteAll(openId) {
  await fetch(`${SUPABASE_URL}/rest/v1/memos?open_id=eq.${encodeURIComponent(openId)}`, {
    method: 'DELETE',
    headers: sbHeaders(),
  })
}

// ── 飞书 API ──────────────────────────────────────────────

async function getTenantToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  })
  const data = await res.json()
  return data.tenant_access_token
}

async function reply(token, chatId, text) {
  await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })
}

// ── 指令处理 ──────────────────────────────────────────────

const HELP_TEXT = `👋 你好！支持以下指令：

📋 备忘录
• 记录 xxx — 保存一条备忘
• 备忘录 — 查看全部备忘
• 删除第N条 — 删除指定备忘
• 清空备忘录 — 清空所有备忘

发送「帮助」可再次查看`

async function handleCommand(openId, chatId, text, token) {
  // 记录备忘
  const addMatch = text.match(/^(记录|备忘|记一下|记下)\s+(.+)/)
  if (addMatch) {
    const content = addMatch[2].trim()
    await memoInsert(openId, content)
    await reply(token, chatId, `✅ 已记录：${content}`)
    return
  }

  // 查看备忘录
  if (/^(备忘录|我的备忘录|查看备忘|所有备忘)$/.test(text)) {
    const list = await memoList(openId)
    if (!list || list.length === 0) {
      await reply(token, chatId, '📋 备忘录为空')
    } else {
      const lines = list.map((m, i) => {
        const date = new Date(m.created_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
        return `${i + 1}. ${m.content}（${date}）`
      }).join('\n')
      await reply(token, chatId, `📋 备忘录（共 ${list.length} 条）\n\n${lines}`)
    }
    return
  }

  // 删除某条
  const delMatch = text.match(/^删除第?(\d+)条?$/)
  if (delMatch) {
    const index = parseInt(delMatch[1]) - 1
    const list = await memoList(openId)
    if (!list || index < 0 || index >= list.length) {
      await reply(token, chatId, `❌ 没有第 ${index + 1} 条备忘`)
    } else {
      await memoDelete(list[index].id)
      await reply(token, chatId, `🗑️ 已删除：${list[index].content}`)
    }
    return
  }

  // 清空
  if (/^清空备忘录$/.test(text)) {
    await memoDeleteAll(openId)
    await reply(token, chatId, '🗑️ 备忘录已清空')
    return
  }

  // 帮助
  if (/^(帮助|help|\?)$/i.test(text)) {
    await reply(token, chatId, HELP_TEXT)
    return
  }

  // 未识别
  await reply(token, chatId, `不太理解这个指令 😅\n发送「帮助」查看支持的功能`)
}

// ── 主入口 ────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body

  // 飞书 URL 验证
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge })
  }

  // 只处理文本消息事件
  if (body.header?.event_type !== 'im.message.receive_v1') {
    return res.json({ ok: true })
  }

  const event = body.event
  const message = event?.message
  if (!message || message.message_type !== 'text') {
    return res.json({ ok: true })
  }

  let text = ''
  try {
    text = JSON.parse(message.content).text?.trim() || ''
  } catch {
    return res.json({ ok: true })
  }

  if (!text) return res.json({ ok: true })

  const openId = event.sender.sender_id.open_id
  const chatId = message.chat_id
  const token = await getTenantToken()

  await handleCommand(openId, chatId, text, token)

  return res.json({ ok: true })
}
