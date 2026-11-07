// TableGen 轻量扫描：词法掩码 + def/class + 字段抽取。不做完整 TableGen parser。

const DEF_RE = /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_:]*)\s*/g
const CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*/g
const INCLUDE_RE = /\binclude\s+"([^"]+)"/g

export const DESCRIPTION_LIMIT = 8 * 1024

/** 1 = 代码字符；0 = 注释 / 字符串 / [{ ... }] 文档块。 */
export function lex(text) {
  const n = text.length
  const code = new Uint8Array(n)
  let i = 0
  let state = 0 // 0 code, 1 line comment, 2 block comment, 3 string, 4 doc block
  while (i < n) {
    const c = text[i]
    if (state === 0) {
      if (c === '/' && text[i + 1] === '/') { state = 1; i += 2; continue }
      if (c === '/' && text[i + 1] === '*') { state = 2; i += 2; continue }
      if (c === '"') { state = 3; i++; continue }
      if (c === '[' && text[i + 1] === '{') { state = 4; i += 2; continue }
      code[i] = 1
      i++
      continue
    }
    if (state === 1) {
      if (c === '\n') { state = 0; code[i] = 1 }
      i++
      continue
    }
    if (state === 2) {
      if (c === '*' && text[i + 1] === '/') { state = 0; i += 2 } else i++
      continue
    }
    if (state === 3) {
      if (c === '\\') { i += 2; continue }
      if (c === '"') state = 0
      else if (c === '\n') { state = 0; code[i] = 1 }
      i++
      continue
    }
    // state 4: doc block [{ ... }]
    if (c === '}' && text[i + 1] === ']') { state = 0; i += 2 } else i++
  }
  return code
}

export class LineIndex {
  constructor(text) {
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    this.starts = starts
  }

  lineOf(idx) {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** 按顶层分隔符切分（尊重 <> () [] {} 与字符串）。 */
export function splitTopLevel(s, sep = ',') {
  const out = []
  let depth = 0
  let inStr = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '<' || c === '(' || c === '[' || c === '{') { depth++; continue }
    if (c === '>' || c === ')' || c === ']' || c === '}') { depth--; continue }
    if (depth === 0 && c === sep) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

export function matchDelim(text, code, openIdx) {
  const open = text[openIdx]
  const close = open === '<' ? '>' : open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (!code[i]) continue
    const c = text[i]
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function unescapeString(s) {
  return s.replace(/\\(["\\nrt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }[c]))
}

function readString(text, from) {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] !== '"') return null
  let out = ''
  i++
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue }
    if (c === '"') return { value: unescapeString(out), start: from, end: i + 1 }
    out += c
    i++
  }
  return null
}

/** 只读某个 let 的字符串值（用于 dialect 的 name / cppNamespace）。 */
function readLetString(body, letName) {
  const re = new RegExp(`\\blet\\s+${letName}\\s*=\\s*`)
  const m = re.exec(body)
  if (!m) return null
  const str = readString(body, m.index + m[0].length)
  return str ? str.value.trim() : null
}

function dedent(s) {
  const lines = s.split(/\r?\n/)
  if (lines.length && lines[0].trim() === '') lines.shift()
  let min = Infinity
  for (const line of lines) {
    if (!line.trim()) continue
    const m = /^[ \t]*/.exec(line)[0].length
    if (m < min) min = m
  }
  if (!Number.isFinite(min)) min = 0
  return lines.map((l) => l.slice(Math.min(min, l.length))).join('\n').replace(/\s+$/, '')
}

export function isAttrType(type) {
  return /(?:^|[<\s,])\w*Attr(?:<|\b)/.test(type) || /\bAttribute\b/.test(type)
}

export function isVariadicType(type) {
  return /^(?:Variadic|Optional)\s*</.test(type.trim())
}

function unwrapVariadic(type) {
  const m = /^(?:Variadic|Optional)\s*<([\s\S]*)>$/.exec(type.trim())
  return m ? m[1].trim() : type.trim()
}

/** 解析 `(ins ...)` / `(outs ...)` 内部文本。 */
export function parseArgList(inner, { isResults = false } = {}) {
  const text = inner.replace(/^\s*(?:ins|outs)\b/, '')
  const items = splitTopLevel(text)
    .map((x) => x.trim())
    .filter(Boolean)
  const operands = []
  const attributes = []
  for (const item of items) {
    const m = /^([\s\S]*?)\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(item)
    if (!m) continue
    const rawType = m[1].trim()
    const name = m[2]
    const variadic = isVariadicType(rawType)
    const type = unwrapVariadic(rawType)
    const rec = { name, type, variadic }
    if (!isResults && isAttrType(rawType)) attributes.push(rec)
    else operands.push(rec)
  }
  return { operands, attributes }
}

export function extractInterfaces(traits) {
  const out = []
  for (const trait of traits) {
    const re1 = /DeclareOpInterfaceMethods\s*<\s*([A-Za-z_][A-Za-z0-9_]*)/g
    let m
    while ((m = re1.exec(trait))) if (!out.includes(m[1])) out.push(m[1])
    const re2 = /(?:^|[<,\s])([A-Za-z_][A-Za-z0-9_]*OpInterface)\b/g
    while ((m = re2.exec(trait))) if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

function findParenAfter(body, bodyAbs, re) {
  const m = re.exec(body)
  if (!m) return null
  const openIdx = body.indexOf('(', m.index + m[0].length)
  if (openIdx < 0) return null
  let depth = 0
  for (let i = openIdx; i < body.length; i++) {
    const c = body[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return { inner: body.slice(openIdx + 1, i), abs: bodyAbs + openIdx }
    }
  }
  return null
}

function findBracketAfter(body, re) {
  const m = re.exec(body)
  if (!m) return null
  const openIdx = body.indexOf('[', m.index + m[0].length)
  if (openIdx < 0) return null
  let depth = 0
  let inStr = false
  for (let i = openIdx; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return body.slice(openIdx + 1, i)
    }
  }
  return null
}

export function parseBody(body, bodyAbs, li) {
  const result = {
    summary: null,
    summaryLine: null,
    description: null,
    descriptionTruncated: false,
    descFirstLine: null,
    args: null,
    results: null,
    regions: null,
  }

  const sumStart = body.search(/\blet\s+summary\s*=\s*/)
  if (sumStart >= 0) {
    const m = /\blet\s+summary\s*=\s*/.exec(body.slice(sumStart))
    const valueStart = sumStart + m[0].length
    const str = readString(body, valueStart)
    if (str) {
      result.summary = str.value.trim()
      result.summaryLine = li.lineOf(bodyAbs + valueStart + body.slice(valueStart).indexOf('"'))
    }
  }

  const descStart = body.search(/\blet\s+description\s*=\s*\[\{/)
  if (descStart >= 0) {
    const open = body.indexOf('[{', descStart)
    const end = body.indexOf('}]', open + 2)
    if (end > 0) {
      const raw = body.slice(open + 2, end)
      result.description = dedent(raw)
      if (result.description.length > DESCRIPTION_LIMIT) {
        result.description = result.description.slice(0, DESCRIPTION_LIMIT)
        result.descriptionTruncated = true
      }
      const contentAbs = bodyAbs + open + 2
      result.descLine = li.lineOf(bodyAbs + descStart)
      result.descFirstLine = li.lineOf(contentAbs + (raw.startsWith('\n') ? 1 : 0))
    }
  }

  const args = findParenAfter(body, bodyAbs, /\blet\s+arguments\s*=\s*/)
  if (args) {
    const parsed = parseArgList(args.inner)
    result.args = { operands: parsed.operands, attributes: parsed.attributes }
  }

  const outs = findParenAfter(body, bodyAbs, /\blet\s+results\s*=\s*/)
  if (outs) {
    const parsed = parseArgList(outs.inner, { isResults: true })
    result.results = parsed.operands
  }

  const regions = findParenAfter(body, bodyAbs, /\blet\s+regions\s*=\s*/)
  if (regions) {
    const names = regions.inner.match(/:\$[A-Za-z_][A-Za-z0-9_]*/g)
    result.regions = names ? names.length : 0
  }

  return result
}

function parseHeaderAngle(text, code, idx) {
  // idx 指向 '<'，返回 { inner, end }（end 是 '>' 的下标）
  const end = matchDelim(text, code, idx)
  if (end < 0) return null
  return { inner: text.slice(idx + 1, end), end }
}

function parseOpHeader(inner) {
  const items = splitTopLevel(inner).map((x) => x.trim())
  const m = /^"([^"]*)"/.exec(items[0] || '')
  if (!m) return null
  const opName = m[1]
  let traits = []
  const second = items[1]
  if (second && second.startsWith('[')) {
    const close = second.lastIndexOf(']')
    traits = splitTopLevel(second.slice(1, close))
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return { opName, traits }
}

function parseClassBase(baseText, li, file, code, offset) {
  const bases = []
  let sigArgs = null
  let sigResults = null
  for (const raw of splitTopLevel(baseText)) {
    const item = raw.trim()
    if (!item) continue
    const argsMatch = /^Arguments\s*</.exec(item)
    if (argsMatch) {
      const inner = item.slice(argsMatch[0].length - 1)
      const p = findParenInText(inner)
      if (p) sigArgs = parseArgList(p)
      continue
    }
    const resMatch = /^Results\s*</.exec(item)
    if (resMatch) {
      const inner = item.slice(resMatch[0].length - 1)
      const p = findParenInText(inner)
      if (p) sigResults = parseArgList(p, { isResults: true }).operands
      continue
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(item)
    if (name && !bases.includes(name[1])) bases.push(name[1])
  }
  return { bases, sigArgs, sigResults }
}

function findParenInText(s) {
  const open = s.indexOf('(')
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth === 0) return s.slice(open + 1, i)
    }
  }
  return null
}

/** 在 [from, to) 内找 `Kw<...>` 并返回尖括号里的内容（只按代码字符配对）。 */
function findAngleArgList(text, code, from, to, kw) {
  const re = new RegExp(`\\b${kw}\\s*<`, 'g')
  const sub = text.slice(from, to)
  const m = re.exec(sub)
  if (!m) return null
  const openIdx = from + m.index + m[0].length - 1
  const end = matchDelim(text, code, openIdx)
  if (end < 0 || end > to) return null
  return text.slice(openIdx + 1, end)
}

/**
 * 解析一个 .td 文件：dialect def、class 声明、op def。
 * 返回 { includes, classes, dialects, ops }。
 */
export function parseTdFile(file, text) {
  const code = lex(text)
  const li = new LineIndex(text)
  const includes = []
  let m
  INCLUDE_RE.lastIndex = 0
  while ((m = INCLUDE_RE.exec(text))) {
    if (code[m.index] === 1) includes.push(m[1])
  }

  const classes = []
  CLASS_RE.lastIndex = 0
  while ((m = CLASS_RE.exec(text))) {
    if (code[m.index] !== 1) continue
    const name = m[1]
    const line = li.lineOf(m.index)
    let pos = m.index + m[0].length
    while (pos < text.length && /\s/.test(text[pos])) pos++
    if (text[pos] === '<') {
      const angle = parseHeaderAngle(text, code, pos)
      if (!angle) continue
      pos = angle.end + 1
    }
    while (pos < text.length && /\s/.test(text[pos])) pos++
    if (text[pos] !== ':') continue
    pos++
    let depth = 0
    let start = pos
    let end = -1
    for (; pos < text.length; pos++) {
      const c = text[pos]
      if (!code[pos]) continue
      if (c === '<' || c === '(' || c === '[') depth++
      else if (c === '>' || c === ')' || c === ']') depth--
      else if (depth === 0 && (c === '{' || c === ';')) { end = pos; break }
    }
    if (end < 0) continue
    // 基类列表里常夹注释（`> :` 后换行 + // 说明）。把非代码字符换成空格，
    // 否则 splitTopLevel 的首项会以 `//` 开头，基类名提取失败。
    let baseText = ''
    for (let k = start; k < end; k++) baseText += code[k] ? text[k] : ' '
    const parsed = parseClassBase(baseText, li, file, code, start)
    let body = null
    let bodyEnd = end
    if (text[end] === '{') {
      const close = matchDelim(text, code, end)
      if (close < 0) continue
      body = parseBody(text.slice(end + 1, close), end + 1, li)
      bodyEnd = close
    }
    classes.push({
      name,
      file,
      line,
      endLine: li.lineOf(bodyEnd),
      bases: parsed.bases,
      sigArgs: parsed.sigArgs,
      sigResults: parsed.sigResults,
      body,
    })
  }

  const ops = []
  const dialects = []
  DEF_RE.lastIndex = 0
  while ((m = DEF_RE.exec(text))) {
    if (code[m.index] !== 1) continue
    const defName = m[1]
    const baseName = m[2]
    const line = li.lineOf(m.index)
    const isDialect = baseName === 'Dialect'
    let pos = m.index + m[0].length
    let header = null
    let headerEnd = pos
    if (text[pos] === '<') {
      const angle = parseHeaderAngle(text, code, pos)
      if (!angle) continue
      header = parseOpHeader(angle.inner)
      if (!header) continue
      pos = angle.end + 1
      headerEnd = pos
    } else if (!isDialect) {
      continue // op def 必须有 <"mnemonic", ...>
    }
    // def 头后面可能继续跟 `Arguments<...>` / `Results<...>` 等基类片段，
    // 一路跳到深度 0 的 `{`（有体）或 `;`（无体）。
    {
      let depth = 0
      let p = pos
      for (; p < text.length; p++) {
        const c = text[p]
        if (!code[p]) continue
        if (c === '<' || c === '(' || c === '[') depth++
        else if (c === '>' || c === ')' || c === ']') depth--
        else if (depth === 0 && (c === '{' || c === ';')) break
      }
      pos = p
    }
    const headerArgs = findAngleArgList(text, code, headerEnd, pos, 'Arguments')
    const headerResults = findAngleArgList(text, code, headerEnd, pos, 'Results')
    const applyHeaderFields = (body) => {
      if (headerArgs != null) {
        const p = parseArgList(headerArgs)
        body.args = { operands: p.operands, attributes: p.attributes }
      }
      if (headerResults != null) body.results = parseArgList(headerResults, { isResults: true }).operands
      return body
    }
    if (text[pos] === ';') {
      if (!isDialect) {
        ops.push({
          defName,
          baseName,
          opName: header.opName,
          traits: header.traits,
          file,
          line,
          endLine: line,
          body: applyHeaderFields({
            summary: null,
            summaryLine: null,
            description: null,
            descriptionTruncated: false,
            descFirstLine: null,
            args: null,
            results: null,
            regions: null,
          }),
        })
      }
      continue
    }
    if (text[pos] !== '{') continue
    const close = matchDelim(text, code, pos)
    if (close < 0) continue
    const bodyRaw = text.slice(pos + 1, close)
    const body = applyHeaderFields(parseBody(bodyRaw, pos + 1, li))

    if (isDialect) {
      const name = readLetString(bodyRaw, 'name')
      const cppNamespace = readLetString(bodyRaw, 'cppNamespace')
      dialects.push({
        id: name || defName,
        defName,
        name: name || defName,
        cppNamespace,
        summary: body.summary,
        description: body.description,
        file,
        line,
        endLine: li.lineOf(close),
      })
      continue
    }

    ops.push({
      defName,
      baseName,
      opName: header.opName,
      traits: header.traits,
      file,
      line,
      endLine: li.lineOf(close),
      body,
    })
  }

  return { includes, classes, dialects, ops }
}
