// YAML 서브셋 파서 — 의존성 0으로 가기 위해 직접 짠다.
//
// 지원: 중첩 맵(들여쓰기) · 블록 리스트(`- x`) · 인라인 리스트(`[a, b]`) · 주석 · 따옴표
//       스칼라 자동변환(숫자·true/false·null)
// 미지원: 앵커/별칭 · 복수 문서 · 블록 스칼라(| >) · 복합 키
//
// profile.yml 과 role-presets.yml 만 읽으면 되므로 이 범위로 충분하다.
// 🔴 범위를 넘는 문법을 만나면 조용히 무시하지 말고 줄 번호와 함께 던진다 —
//    설정이 잘못 읽히면 수집 조건이 통째로 어긋나는데 사용자는 그걸 알 방법이 없다.

const DENY = /^\s*(?:[&*]|---|\?\s|<<:)/;

function scalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (/^"(.*)"$/s.test(s)) return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  if (/^'(.*)'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

// 인라인 리스트 `[a, "b, c", d]` — 따옴표 안의 콤마를 존중한다.
function inlineList(raw) {
  const body = raw.trim().slice(1, -1);
  const out = [];
  let cur = '', q = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map(scalar);
}

// 값 뒤 주석 제거. 따옴표 안의 #는 주석이 아니다.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (DENY.test(raw)) throw new Error(`yaml: 지원하지 않는 문법 (${i + 1}행): ${raw.trim()}`);
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) return;
    lines.push({ n: i + 1, indent: line.match(/^ */)[0].length, body: line.trim() });
  });

  let i = 0;
  function block(minIndent) {
    if (i >= lines.length) return null;
    const indent = lines[i].indent;
    return lines[i].body.startsWith('- ') || lines[i].body === '-'
      ? list(indent, minIndent)
      : map(indent, minIndent);
  }

  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && /^-(\s|$)/.test(lines[i].body)) {
      const { n, body } = lines[i];
      const rest = body.slice(1).trim();
      i++;
      if (rest === '') {                                   // - 다음 줄에 중첩
        out.push(i < lines.length && lines[i].indent > indent ? block(indent + 1) : null);
      } else if (/^[\w".'\-][^:]*:(\s|$)/.test(rest)) {    // - key: value (리스트 안의 맵)
        const sub = { [rest.slice(0, rest.indexOf(':')).trim()]: value(rest.slice(rest.indexOf(':') + 1), indent + 2) };
        while (i < lines.length && lines[i].indent > indent && !/^-(\s|$)/.test(lines[i].body)) {
          const b = lines[i].body, c = b.indexOf(':');
          if (c < 0) throw new Error(`yaml: 키:값이 아닌 줄 (${lines[i].n}행): ${b}`);
          const k = b.slice(0, c).trim(); const inner = lines[i].indent; i++;
          sub[k] = value(b.slice(c + 1), inner);
        }
        out.push(sub);
      } else {
        out.push(rest.startsWith('[') ? inlineList(rest) : scalar(rest));
      }
    }
    return out;
  }

  function value(rawRest, parentIndent) {
    const rest = rawRest.trim();
    if (rest.startsWith('[')) return inlineList(rest);
    if (rest.startsWith('{')) throw new Error('yaml: 인라인 맵은 지원하지 않는다');
    if (rest !== '') return scalar(rest);
    if (i < lines.length && lines[i].indent > parentIndent) return block(lines[i].indent);
    return null;                                            // 값 없는 키 = null
  }

  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !/^-(\s|$)/.test(lines[i].body)) {
      const { n, body } = lines[i];
      const c = body.indexOf(':');
      if (c < 0) throw new Error(`yaml: 키:값이 아닌 줄 (${n}행): ${body}`);
      const key = scalar(body.slice(0, c));
      i++;
      out[String(key)] = value(body.slice(c + 1), indent);
    }
    return out;
  }

  const root = block(0);
  if (i < lines.length) throw new Error(`yaml: 들여쓰기가 어긋난 줄 (${lines[i].n}행): ${lines[i].body}`);
  return root ?? {};
}
