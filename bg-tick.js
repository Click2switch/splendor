/*
 * 后台心跳。
 *
 * 主线程的 setInterval 在隐藏标签页里会被浏览器降频：先压到 1 秒，藏久了压到
 * 一分钟一次（Chrome 的 intensive throttling）。心跳一次都不该落到这个坑里 ——
 * 断线判不出来、重连也排不上队，切回来就是「卡一下」。
 *
 * Worker 的定时器只会被对齐到 1 秒，不会被压到一分钟，正好拿来当心跳时钟。
 * 它只负责报时，真正的判断仍然留在主线程（那边才知道 socket 长什么样）。
 */

let timer = null;

self.onmessage = (e) => {
  const d = e.data || {};
  if (d.type === 'start') {
    if (timer) clearInterval(timer);
    const every = Math.max(250, Number(d.every) || 1000);
    timer = setInterval(() => self.postMessage({ type: 'tick', t: Date.now() }), every);
    self.postMessage({ type: 'started', every });
  } else if (d.type === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
  }
};
