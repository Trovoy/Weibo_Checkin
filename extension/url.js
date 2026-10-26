export function workerOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw Error('只填写 HTTPS Worker 根地址，不带路径或参数');
  return url.origin;
}
