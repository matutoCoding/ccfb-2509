/** 极简 DOM 构建辅助 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

export function toast(message: string, ms = 2600): void {
  const t = el('div', { class: 'toast' }, message);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function modal(content: HTMLElement, onClose?: () => void): () => void {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal' });
  box.appendChild(content);
  backdrop.appendChild(box);
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  document.body.appendChild(backdrop);
  function close(): void {
    backdrop.remove();
    onClose?.();
  }
  return close;
}

export function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label', { class: 'field' }, el('span', {}, label), input);
  return wrap;
}

export function numInput(value: number, step = 1): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.step = String(step);
  i.value = String(value);
  return i;
}

export function textInput(value: string): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  return i;
}
