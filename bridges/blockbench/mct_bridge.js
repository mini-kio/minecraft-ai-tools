/* MCT desktop bridge. No model files are saved or overwritten by this plugin. */
(function () {
  let socket, reconnect, preview, alive = false, busy = Promise.resolve();
  const owned = new Set();
  function argumentNumber(value, name) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw Object.assign(new Error(name + ' must be finite'), { code: 'INVALID_ARGUMENT' });
    return n;
  }
  function vector(value, name) { return ['x', 'y', 'z'].map(axis => argumentNumber(value[axis], name + '.' + axis)); }
  function filesystem(file) {
    const path = require('path');
    // Blockbench 5.2 scopes native modules and requests filesystem permission.
    // Old desktop versions ignore the optional second argument. Permission is
    // always left to Blockbench and its user; this plugin never grants it.
    const fs = require('fs', { scope: path.dirname(file), optional: false, message: 'MCT reads model/config files for observation and never saves over them.' });
    if (!fs) throw Object.assign(new Error('Allow the requested model/config folder in Blockbench before using this action.'), { code: 'FILESYSTEM_PERMISSION_REQUIRED' });
    return fs;
  }
  function config() {
    if (typeof require !== 'function') throw new Error('MCT bridge requires Blockbench Desktop');
    const manual = localStorage.getItem('mct_bridge_config');
    let contents = manual;
    if (!contents) {
      if (parseInt(Blockbench.version, 10) >= 5) throw new Error('Paste mct bridge config into Tools → MCT: 연결 설정. Model files are read by the CLI; Blockbench filesystem access is not required.');
      const path = require('path');
      const home = typeof SystemInfo !== 'undefined' && SystemInfo.home_directory ? SystemInfo.home_directory : require('os').homedir();
      // New Blockbench releases deliberately do not expose global process.
      // Pasted connection JSON also avoids any native-module request at connect.
      const state = typeof process !== 'undefined' && process.env ? process.env.MCT_STATE_DIR : undefined;
      const file = path.join(state || path.join(home, 'Downloads', 'minecraft-ai-tools', '.mct'), 'bridge-config.json');
      contents = filesystem(file).readFileSync(file, 'utf8');
    }
    const cfg = JSON.parse(contents);
    const endpoint = new URL(cfg.endpoint);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1') throw new Error('MCT only connects to ws://127.0.0.1');
    return cfg;
  }
  function select(args) {
    const project = ModelProject.all.find(p => p.uuid === args.project);
    if (!project || !owned.has(project.uuid)) throw Object.assign(new Error('MCT project is no longer open'), { code: 'PROJECT_NOT_FOUND' });
    if (Project !== project) project.select();
    return project;
  }
  function info() {
    return { project: Project.uuid, name: Project.name, format: Format.id, elements: Outliner.elements.map(e => ({ uuid: e.uuid, name: e.name, type: e.type, parent: e.parent && e.parent.uuid || null, from: e.from, to: e.to, origin: e.origin, rotation: e.rotation, vertices: e.vertices, faces: e.faces && Object.fromEntries(Object.entries(e.faces).map(([side, f]) => [side, { uv: f.uv, vertices: f.vertices, texture: f.texture, rotation: f.rotation }])) })), groups: Group.all.map(g => ({ uuid: g.uuid, name: g.name, parent: g.parent && g.parent.uuid || null, children: g.children.map(c => c.uuid), origin: g.origin, rotation: g.rotation })), textures: Texture.all.map(t => ({ uuid: t.uuid, name: t.name, width: t.width, height: t.height, error: t.error })), animations: (typeof Animation !== 'undefined' ? Animation.all : []).map(a => ({ uuid: a.uuid, name: a.name, length: a.length, loop: a.loop })), observedAt: new Date().toISOString() };
  }
  function getPreview() {
    if (!preview) { preview = new Preview({ id: 'mct_offscreen', offscreen: true }); preview.resize(1280, 800); }
    return preview;
  }
  async function handle(action, args) {
    if (action === 'model.open') {
      const data = JSON.parse(args.sourceText === undefined ? filesystem(args.path).readFileSync(args.path, 'utf8') : args.sourceText);
      const codec = data.meta ? Codecs.project : data.elements || data.parent ? Codecs.java_block : null;
      if (!codec) throw Object.assign(new Error('Expected .bbmodel or Java block/item model JSON'), { code: 'UNSUPPORTED_FORMAT' });
      const before = new Set(ModelProject.all.map(p => p.uuid));
      codec.load(data, { path: args.path, name: require('path').basename(args.path) });
      if (before.has(Project.uuid)) throw Object.assign(new Error('Blockbench did not open a dedicated project'), { code: 'MODEL_LOAD_FAILED' });
      owned.add(Project.uuid); Canvas.updateAll(); return info();
    }
    select(args);
    if (action === 'model.inspect') return info();
    if (action === 'model.reload') {
      // A malformed external edit must not close the last working observation.
      const candidate = JSON.parse(args.sourceText === undefined ? filesystem(args.path).readFileSync(args.path, 'utf8') : args.sourceText);
      if (!candidate.meta && !candidate.elements && !candidate.parent) throw Object.assign(new Error('Expected .bbmodel or Java block/item model JSON'), { code: 'UNSUPPORTED_FORMAT' });
      const old = Project;
      if (await old.close(true) === false) throw Object.assign(new Error('Blockbench refused to close the current MCT project'), { code: 'PROJECT_CLOSE_FAILED' });
      owned.delete(old.uuid);
      return handle('model.open', args);
    }
    if (action === 'model.close') { const old = Project; if (await old.close(true) === false) throw Object.assign(new Error('Blockbench refused to close the current MCT project'), { code: 'PROJECT_CLOSE_FAILED' }); owned.delete(old.uuid); return { closed: true }; }
    if (action === 'model.camera') {
      const p = getPreview();
      const position = args.position && vector(args.position, 'position'), target = args.target && vector(args.target, 'target');
      if (position) p.camera.position.set(...position);
      if (target) p.controls.target.set(...target);
      p.controls.update(); p.render(); return { position: p.camera.position.toArray(), target: p.controls.target.toArray() };
    }
    if (action === 'model.animation') {
      const animation = Animation.all.find(a => a.name === args.clip || a.uuid === args.clip);
      if (!animation) throw Object.assign(new Error('Animation clip not found'), { code: 'ANIMATION_NOT_FOUND' });
      const time = argumentNumber(args.time === undefined ? 0 : args.time, 'time');
      if (time < 0) throw Object.assign(new Error('time must not be negative'), { code: 'INVALID_ARGUMENT' });
      // Modes.animate is a boolean state flag in supported Blockbench versions;
      // the selectable mode lives in Modes.options.animate.
      const animateMode = typeof Modes !== 'undefined' && (Modes.options && Modes.options.animate || (typeof Modes.animate === 'object' && Modes.animate));
      if (!animateMode || typeof animateMode.select !== 'function') throw Object.assign(new Error('This project does not expose an animation mode'), { code: 'ANIMATION_UNSUPPORTED' });
      animateMode.select();
      animation.select(); Timeline.pause(); Timeline.setTime(time); Animator.preview();
      if (args.play) Timeline.start(); return { clip: animation.name, time: Timeline.time, length: animation.length };
    }
    if (action === 'model.capture') {
      const width = argumentNumber(args.width === undefined ? 1280 : args.width, 'width'), height = argumentNumber(args.height === undefined ? 800 : args.height, 'height');
      const p = getPreview(); p.resize(Math.min(4096, Math.max(64, Math.round(width))), Math.min(4096, Math.max(64, Math.round(height))));
      // Geometry refresh resets bone transforms. Apply the chosen animation
      // afterwards so the pixels and reported timeline time agree.
      Canvas.updateAll();
      if (args.clip) await handle('model.animation', args);
      else if (typeof Modes !== 'undefined' && Modes.selected && Modes.selected.id === 'animate') Animator.preview();
      p.render();
      const dataUrl = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Blockbench screenshot timeout')), 12000); p.screenshot({ width: p.width, height: p.height, crop: false }, url => { clearTimeout(timer); resolve(url); }); });
      return { dataUrl, project: Project.uuid, animationTime: typeof Timeline !== 'undefined' ? Timeline.time : null, camera: { position: p.camera.position.toArray(), target: p.controls.target.toArray() }, observedAt: new Date().toISOString() };
    }
    throw Object.assign(new Error('Unsupported MCT action: ' + action), { code: 'UNKNOWN_ACTION' });
  }
  function connect() {
    if (!alive) return;
    try {
      const cfg = config(); socket = new WebSocket(cfg.endpoint);
      socket.onopen = () => socket.send(JSON.stringify({ kind: 'blockbench', token: cfg.token, protocol: 1, name: 'Blockbench Desktop', version: Blockbench.version, capabilities: ['model.open', 'model.inspect', 'model.camera', 'model.animation', 'model.capture', 'model.reload', 'model.close'] }));
      socket.onmessage = event => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; } if (msg.type !== 'request') return;
        busy = busy.then(async () => { try { const result = await handle(msg.action, msg.args || {}); if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'response', id: msg.id, result })); } catch (e) { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'response', id: msg.id, error: { code: e.code || 'BLOCKBENCH_ERROR', message: e.message } })); } });
      };
      socket.onclose = () => { if (alive) reconnect = setTimeout(connect, 3000); }; socket.onerror = () => socket.close();
    } catch (e) { console.warn('[MCT]', e.message); reconnect = setTimeout(connect, 3000); }
  }
  let settingsAction;
  Plugin.register('mct_bridge', { title: 'MCT Observation Bridge', author: 'Minecraft AI Tools', description: 'Local AI observation of models, camera and animation. Desktop only.', icon: 'visibility', version: '0.1.0', min_version: '4.10.0', variant: 'desktop',
    onload() {
      alive = true; connect();
      settingsAction = new Action('mct_bridge_settings', { name: 'MCT: 연결 설정', icon: 'settings', click() { new Dialog({ id: 'mct_config', title: 'MCT bridge config', form: { config: { label: 'mct bridge config의 endpoint/token JSON', type: 'textarea', value: localStorage.getItem('mct_bridge_config') || '' } }, onConfirm(form) { if (form.config.trim()) { JSON.parse(form.config); localStorage.setItem('mct_bridge_config', form.config); } else localStorage.removeItem('mct_bridge_config'); if (socket) socket.close(); this.hide(); } }).show(); } });
      MenuBar.addAction(settingsAction, 'tools');
    },
    onunload() { alive = false; clearTimeout(reconnect); if (socket) socket.close(); if (preview) preview.delete(); if (settingsAction) settingsAction.delete(); }
  });
})();
