#!/usr/bin/env node

function usage() {
  console.log(`Usage:
  node scripts/g4f-meta-smoke.mjs --kind=description --topic="..." [--language=ru] [--category="People & Blogs"] [--kids=0]
  node scripts/g4f-meta-smoke.mjs --kind=tags --topic="..." [--language=ru] [--category="People & Blogs"] [--kids=0]

Env:
  G4F_BASE_URL   default: http://127.0.0.1:1337/v1
  G4F_MODEL      default: gpt-4o-mini
  G4F_API_KEY    optional
`)
}

function parseArgs(argv) {
  const out = {
    kind: "",
    topic: "",
    language: "ru",
    category: "People & Blogs",
    kids: false
  }
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") return { help: true }
    if (!raw.startsWith("--")) continue
    const [k, ...rest] = raw.slice(2).split("=")
    const v = rest.join("=")
    if (k === "kind") out.kind = v
    else if (k === "topic") out.topic = v
    else if (k === "language") out.language = v || "ru"
    else if (k === "category") out.category = v || "People & Blogs"
    else if (k === "kids") out.kids = v === "1" || v === "true"
  }
  return { help: false, ...out }
}

function buildPrompt(input) {
  if (input.kind === "description") {
    return {
      system:
        "Ты пишешь краткие SEO-friendly описания для YouTube. Верни только чистый текст описания без Markdown и без пояснений.",
      user: [
        `Язык: ${input.language}`,
        `Категория: ${input.category}`,
        `Для детей: ${input.kids ? "да" : "нет"}`,
        "",
        "Задача: создай короткое описание YouTube-видео (2-4 предложения).",
        "В конце новой строкой добавь РОВНО 3 тематических хештега.",
        "Не добавляй ничего кроме итогового текста.",
        "",
        `Тема видео от пользователя: ${input.topic}`
      ].join("\n")
    }
  }
  return {
    system:
      "Ты генерируешь только список тегов для YouTube. Верни одну строку: теги через запятую, без объяснений.",
    user: [
      `Язык: ${input.language}`,
      `Категория: ${input.category}`,
      `Для детей: ${input.kids ? "да" : "нет"}`,
      "",
      "Задача: дай релевантные SEO-теги для YouTube-видео.",
      "Формат строго: тег1, тег2, тег3...",
      "Максимум 450 символов итоговой строки.",
      "Без #, без точек с запятой, без нумерации.",
      "",
      `Тема видео от пользователя: ${input.topic}`
    ].join("\n")
  }
}

function normalizeTags(raw) {
  const tokens = raw
    .replaceAll("\n", ",")
    .split(/[,;|]/)
    .map((x) => x.replace(/^#+/, "").trim())
    .filter(Boolean)
  const uniq = []
  const seen = new Set()
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(token)
  }
  let out = ""
  for (const tag of uniq) {
    const candidate = out ? `${out}, ${tag}` : tag
    if (candidate.length > 450) break
    out = candidate
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  if (args.kind !== "description" && args.kind !== "tags") {
    console.error("ERR: --kind must be description|tags")
    usage()
    process.exitCode = 1
    return
  }
  if (!args.topic.trim()) {
    console.error("ERR: --topic is required")
    usage()
    process.exitCode = 1
    return
  }

  const base = (process.env.G4F_BASE_URL || "http://127.0.0.1:1337/v1").replace(/\/$/, "")
  const model = process.env.G4F_MODEL || "gpt-4o-mini"
  const apiKey = process.env.G4F_API_KEY || ""
  const prompt = buildPrompt(args)
  const body = {
    model,
    web_search: false,
    temperature: 0.7,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ]
  }
  const headers = { "Content-Type": "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  console.log("=== G4F META SMOKE ===")
  console.log("URL:", `${base}/chat/completions`)
  console.log("Model:", model)
  console.log("Kind:", args.kind)
  console.log("Topic:", args.topic)
  console.log("Request body:", JSON.stringify(body, null, 2))

  const started = Date.now()
  let res
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    })
  } catch (e) {
    console.error("Network error:", e)
    process.exitCode = 2
    return
  }
  const elapsed = Date.now() - started
  const text = await res.text()
  console.log("HTTP status:", res.status, res.statusText, `(${elapsed}ms)`)
  console.log("Raw response:", text)
  if (!res.ok) {
    process.exitCode = 3
    return
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    console.error("JSON parse error:", e)
    process.exitCode = 4
    return
  }
  const content = String(parsed?.choices?.[0]?.message?.content || "").trim()
  console.log("Model content:", content)
  if (!content) {
    console.error("ERR: empty model content")
    process.exitCode = 5
    return
  }
  const normalized = args.kind === "tags" ? normalizeTags(content) : content
  console.log("--- Normalized output ---")
  console.log(normalized)
  if (args.kind === "tags") {
    console.log("Tag length:", normalized.length)
  }
}

main().catch((e) => {
  console.error("Fatal error:", e)
  process.exitCode = 99
})
