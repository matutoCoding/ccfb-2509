import './ui/styles.css';
import { parseHash, renderNav, navigate, type Route } from './ui/router';
import { store } from './ui/state';
import { renderEnginesPage } from './ui/pages/enginesPage';
import { renderProbesPage } from './ui/pages/probesPage';
import { renderViewportPage } from './ui/pages/viewportPage';
import { renderDamagesPage } from './ui/pages/damagesPage';
import { renderReviewPage } from './ui/pages/reviewPage';

async function boot(): Promise<void> {
  await store.load();
  let currentRoute: Route['page'] | null = null;
  let disposeCurrent: (() => void) | undefined;

  const render = (): void => {
    const route = parseHash();
    if (route.page === currentRoute && route.page !== 'viewport') return;
    disposeCurrent?.();
    disposeCurrent = undefined;
    currentRoute = route.page;
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    app.appendChild(renderNav(route.page));
    const pageHost = document.createElement('div');
    pageHost.style.flex = '1';
    pageHost.style.minWidth = '0';
    pageHost.style.display = 'flex';
    pageHost.style.flexDirection = 'column';
    app.appendChild(pageHost);
    let handle;
    switch (route.page) {
      case 'engines': handle = renderEnginesPage(); break;
      case 'probes': handle = renderProbesPage(); break;
      case 'viewport': handle = renderViewportPage(route.recordId); break;
      case 'damages': handle = renderDamagesPage(); break;
      case 'review': handle = renderReviewPage(); break;
      default: navigate({ page: 'engines' }); return;
    }
    pageHost.appendChild(handle.element);
    disposeCurrent = handle.dispose;
  };

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/engines';
  render();
}

boot().catch((err) => {
  document.getElementById('app')!.innerHTML =
    `<div style="padding:40px;color:#ff9b8e;font-family:sans-serif">启动失败：${String(err)}</div>`;
});
