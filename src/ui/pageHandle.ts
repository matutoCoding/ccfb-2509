/** 页面装配结果：element 挂载到路由宿主，dispose 在离开页面时调用（退订/释放 GPU 资源） */
export interface PageHandle {
  element: HTMLElement;
  dispose?: () => void;
}
