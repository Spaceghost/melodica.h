(() => {
  const installed = Symbol.for('st.spacegho.melodica.device-bridge');
  const shell = /^\/melodica(?:\/(?:app|track|rooms|garden|listens|leaderboard|map|account|aquarium|apps|extension|rooms\/[A-Za-z0-9_-]{16,64}))?\/?$/;
  if (window[installed] || window.top !== window || location.origin !== 'https://spacegho.st' ||
      !shell.test(location.pathname) || window.melodicaDevice) return;
  Object.defineProperty(window,installed,{value:true});
  const pending = new Map();
  let seq = 0;
  let write;
  function receive(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.event) {
      window.dispatchEvent(new CustomEvent('melodica:device', {detail:packet}));
      return;
    }
    const reply = pending.get(packet.id);
    if (!reply) return;
    pending.delete(packet.id);
    clearTimeout(reply.timer);
    if (packet.error) reply.reject(new Error(packet.error));
    else reply.resolve(packet.value);
  }
  function connected(platform) {
    if (!window.melodicaDevice) Object.defineProperty(window,'melodicaDevice',{value:Object.freeze({
      platform,
      call(action, value = {}) {
        return new Promise((resolve,reject) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('The phone did not answer. Reopen Melodica and try again.'));
          }, 90000);
          pending.set(id,{resolve,reject,timer});
          try { write({id,action,value}); }
          catch (e) { receive({id,error:e.message}); }
        });
      }
    })});
    window.dispatchEvent(new Event('melodica:device-ready'));
  }
  if (window.webkit?.messageHandlers?.melodicaMobile) {
    write = packet => window.webkit.messageHandlers.melodicaMobile.postMessage(packet);
    Object.defineProperty(window,'melodicaReceive',{value:receive});
    connected('ios');
  } else {
    let activePort;
    window.addEventListener('message',function accept(event) {
      if (event.data !== 'melodica-device-v1' || event.ports.length !== 1 || event.source) return;
      if (activePort) {
        activePort.close();
        for (const id of [...pending.keys()]) receive({id,error:'The player reconnected to the phone. Try again.'});
      }
      const port = activePort = event.ports[0];
      port.onmessage = msg => { try { receive(JSON.parse(msg.data)); } catch {} };
      write = packet => port.postMessage(JSON.stringify(packet));
      connected('android');
    });
  }
})();
