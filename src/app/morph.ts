// 작은 DOM 패치: 새 HTML과 비교해 바뀐 텍스트·속성·노드만 고친다.
// 패널을 주기적으로 다시 그려도 버튼 요소가 유지되어 클릭·호버가 끊기지 않는다.

function sameKind(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

function patchNode(cur: Node, next: Node) {
  if (cur.nodeType === Node.TEXT_NODE || cur.nodeType === Node.COMMENT_NODE) {
    if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
    return;
  }
  const ce = cur as Element, ne = next as Element;
  for (const attr of Array.from(ce.attributes)) if (!ne.hasAttribute(attr.name)) ce.removeAttribute(attr.name);
  for (const attr of Array.from(ne.attributes)) if (ce.getAttribute(attr.name) !== attr.value) ce.setAttribute(attr.name, attr.value);
  if (ce instanceof HTMLButtonElement && ne instanceof HTMLButtonElement) ce.disabled = ne.disabled;
  patchChildren(ce, ne);
}

function patchChildren(cur: Node, next: Node) {
  const a = Array.from(cur.childNodes);
  const b = Array.from(next.childNodes);
  for (let i = 0; i < b.length; i++) {
    if (i < a.length && sameKind(a[i], b[i])) patchNode(a[i], b[i]);
    else if (i < a.length) cur.replaceChild(b[i].cloneNode(true), a[i]);
    else cur.appendChild(b[i].cloneNode(true));
  }
  for (let i = a.length - 1; i >= b.length; i--) cur.removeChild(a[i]);
}

export function morph(el: HTMLElement, html: string) {
  const t = document.createElement('template');
  t.innerHTML = html;
  patchChildren(el, t.content);
}
