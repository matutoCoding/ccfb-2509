export type Route =
  | { page: 'engines' }
  | { page: 'probes' }
  | { page: 'viewport'; recordId?: string }
  | { page: 'damages' }
  | { page: 'review' };

const PAGES: { route: Route['page']; label: string; icon: string }[] = [
  { route: 'engines', label: '发动机构型', icon: '🛠' },
  { route: 'probes', label: '探头路径', icon: '〰' },
  { route: 'viewport', label: '孔探视窗', icon: '📷' },
  { route: 'damages', label: '损伤标注', icon: '✖' },
  { route: 'review', label: '复查对比', icon: '📈' },
];

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, param] = h.split('/');
  if (page === 'probes') return { page: 'probes' };
  if (page === 'viewport') return { page: 'viewport', recordId: param };
  if (page === 'damages') return { page: 'damages' };
  if (page === 'review') return { page: 'review' };
  return { page: 'engines' };
}

export function navigate(route: Route): void {
  location.hash = route.page === 'viewport' && route.recordId
    ? `#/viewport/${route.recordId}`
    : `#/${route.page}`;
}

export function renderNav(current: Route['page']): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'side-nav';
  const title = document.createElement('div');
  title.className = 'nav-title';
  title.innerHTML = '🔍 孔探规划系统';
  nav.appendChild(title);
  for (const p of PAGES) {
    const btn = document.createElement('button');
    btn.className = `nav-item ${current === p.route ? 'active' : ''}`;
    btn.innerHTML = `<span class="nav-icon">${p.icon}</span>${p.label}`;
    btn.onclick = () => navigate({ page: p.route } as Route);
    nav.appendChild(btn);
  }
  return nav;
}
