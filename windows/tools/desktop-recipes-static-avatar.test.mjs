// Static Bot avatars (the "+ New group chat" recipient picker, its chips and footer marks,
// mentions, the chat header) follow the RokBot avatar style like the sidebar does.
//
// The official GO (AgentAvatar) draws a static avatar without a picture as an <img> of the
// official still mark (sC), bypassing GrokBotMark (bT), the only component the avatar style
// replaces. spec.mjs sends that case through bT unless the style is "official".
//
// The last test runs the real patched GO taken from the official renderer when
// ROKBOT_DESKTOP_TEST_EAGER_APP points at the original 1.3.0 Windows
// dist/renderer/assets/index.eager-app-B8R_eIgV.js (skipped otherwise).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { applyByteRecipe } from '../../mac/patchers/desktop/release-recipes.mjs';
import { buildRecipe } from './desktop-recipes/build.mjs';
import { specForTarget, targetMeta } from './desktop-recipes/spec.mjs';

const HOOK = 'function GO(e){let rokStyledStill=RokUseAvatarStyle()!==`official`;GO.d=133;';
const BRANCH = 'if(A!=null||g&&!v&&!rokStyledStill){';
const eagerApp = target => specForTarget(target).find(entry => entry.path === `dist/renderer/assets/${targetMeta(target).chunks.eagerApp}`);

for (const target of ['windows', 'mac']) {
  test(`${target}: GO reads the avatar style unconditionally and keeps the official still only for "official"`, async () => {
    const entry = eagerApp(target);
    const edits = entry.edits.filter(edit => edit.replace?.startsWith('function GO(') || edit.replace?.startsWith('if(A!=null||g&&!v)'));
    assert.deepEqual(edits.map(edit => edit.text), [HOOK, BRANCH]);
    // Same file as the bT/xT replacement and the avatar-style.js extension that defines RokUseAvatarStyle.
    assert.ok(entry.edits.some(edit => edit.replace === 'function bT(e){bT.d=3834;'));
    assert.ok(entry.edits.some(edit => edit.append?.includes('function RokUseAvatarStyle()')));

    const meta = targetMeta(target);
    const recipesDir = new URL(`../../${meta.recipesRelativeDir}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', recipesDir), 'utf8'));
    const file = manifest.files.find(item => item.path === entry.path);
    const recipe = JSON.parse(gunzipSync(await readFile(new URL(file.recipe, recipesDir))).toString('utf8'));
    const added = recipe.ops.filter(op => op[0] === 'add').map(op => Buffer.from(op[1], 'base64').toString('utf8')).join('\n');
    assert.ok(added.includes('let rokStyledStill=RokUseAvatarStyle()!==`official`;'), `${target} recipe carries the style hook`);
    assert.ok(added.includes('&&!rokStyledStill'), `${target} recipe carries the static branch guard`);
  });
}

// A stand-in with the official GO's anchors and branch order (picture or static still,
// live mark by agent, GrokBotMark), patched by the real spec edits.
const STAND_IN = 'function GO(e){GO.d=133;let{avatarKey:n,dataUrl:r,shape:s,color:c,isStatic:l,isMorphingShape:f}=e,'
  + 'g=l===void 0||l,v=f!==void 0&&f,A=r!=null&&r.length>0?r:null;'
  + 'if(A!=null||g&&!v){return{type:`img`,src:A??sC(n,{shape:s??Ca(n),color:c??Pa(n)})}}'
  + 'if(!g){return{type:`live`}}'
  + 'return bT({color:c??Pa(n),shape:s??Ca(n),isPaused:!0})}';

function standIn(style) {
  const entry = { path: 'eo.js', edits: eagerApp('windows').edits.filter(edit => edit.replace?.startsWith('function GO(') || edit.replace?.startsWith('if(A!=null||g&&!v)')) };
  const source = Buffer.from(STAND_IN);
  const patched = buildRecipe(entry, source).target.toString('utf8');
  const context = vm.createContext({
    RokUseAvatarStyle: () => style,
    sC: (id, look) => `official:${look.shape}:${look.color}`,
    Ca: () => 'blob', Pa: () => 'blue',
    bT: props => ({ type: 'mark', style, ...props }),
  });
  vm.runInContext(`${patched};globalThis.GO=GO;`, context);
  return context.GO;
}

test('a static Bot avatar without a picture is drawn in the RokBot style with its own shape and color', () => {
  const GO = standIn('antenna');
  assert.deepEqual({ ...GO({ avatarKey: 'b1', shape: 'star', color: 'orange', isStatic: true }) },
    { type: 'mark', style: 'antenna', color: 'orange', shape: 'star', isPaused: true });
  // isStatic defaults to true (GO, the picker rows): same path.
  assert.equal(GO({ avatarKey: 'b1', shape: 'heart', color: 'magenta' }).shape, 'heart');
});

test('a Bot without a shape or color falls back to the default look; a custom picture stays a picture', () => {
  const GO = standIn('chassis');
  assert.deepEqual({ ...GO({ avatarKey: 'b2' }) }, { type: 'mark', style: 'chassis', color: 'blue', shape: 'blob', isPaused: true });
  assert.deepEqual({ ...GO({ avatarKey: 'b3', dataUrl: 'data:image/png;base64,AA', shape: 'star' }) },
    { type: 'img', src: 'data:image/png;base64,AA' });
});

test('the "official" style keeps the official still image', () => {
  const GO = standIn('official');
  assert.deepEqual({ ...GO({ avatarKey: 'b1', shape: 'star', color: 'orange' }) }, { type: 'img', src: 'official:star:orange' });
  assert.deepEqual({ ...GO({ avatarKey: 'b2' }) }, { type: 'img', src: 'official:blob:blue' });
});

const realSource = process.env.ROKBOT_DESKTOP_TEST_EAGER_APP;
test('the real patched GO from the official 1.3.0 renderer', { skip: !realSource && 'set ROKBOT_DESKTOP_TEST_EAGER_APP' }, async () => {
  const meta = targetMeta('windows');
  const recipesDir = new URL(`../../${meta.recipesRelativeDir}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', recipesDir), 'utf8'));
  const file = manifest.files.find(item => item.path === eagerApp('windows').path);
  const recipe = JSON.parse(gunzipSync(await readFile(new URL(file.recipe, recipesDir))).toString('utf8'));
  const patched = applyByteRecipe(await readFile(realSource), recipe).toString('utf8');
  const from = patched.indexOf('function GO(e){'), to = patched.indexOf('function KO(e){', from);
  assert.ok(from >= 0 && to > from);

  const run = (style, props) => {
    const calls = [];
    const jsx = (type, p) => ({ type, props: p });
    const context = vm.createContext({
      Q: { c: size => new Array(size) }, Z: { jsx },
      X: { useContext: () => null, useState: value => [value, () => {}] },
      Mi: id => id, Aht: () => null, Lht: () => false, UO: {}, WO: { xs: 16, sm: 22, md: 28, lg: 36, xl: 72 }, EO: 'idle',
      Ca: () => 'blob', Pa: () => 'blue',
      sC: (id, look) => `official:${look.shape}:${look.color}`,
      cC: 'Img', HO: 'LiveMark', bT: 'GrokBotMark',
      RokUseAvatarStyle: () => { calls.push(style); return style; },
    });
    vm.runInContext(`${patched.slice(from, to)};globalThis.GO=GO;`, context);
    return { tree: context.GO(props), calls };
  };

  const styled = run('pixel', { avatarKey: 'b1', shape: 'star', color: 'orange', isStatic: true, size: 'sm' });
  assert.equal(styled.tree.type, 'GrokBotMark');
  assert.equal(styled.tree.props.shape, 'star');
  assert.equal(styled.tree.props.color, 'orange');
  assert.equal(styled.tree.props.isPaused, true);
  assert.equal(styled.tree.props.sizePx, 22);
  assert.deepEqual(styled.calls, ['pixel']);

  const fallback = run('chassis', { avatarKey: 'b2', isStatic: true });
  assert.equal(fallback.tree.type, 'GrokBotMark');
  assert.equal(fallback.tree.props.shape, 'blob');
  assert.equal(fallback.tree.props.color, 'blue');

  const photo = run('chassis', { avatarKey: 'b3', dataUrl: 'data:image/png;base64,AA', isStatic: true });
  assert.equal(photo.tree.type, 'Img');
  assert.equal(photo.tree.props.src, 'data:image/png;base64,AA');

  const official = run('official', { avatarKey: 'b1', shape: 'star', color: 'orange', isStatic: true });
  assert.equal(official.tree.type, 'Img');
  assert.equal(official.tree.props.src, 'official:star:orange');
  // The hook runs on every path, so switching styles never changes the hook order.
  assert.deepEqual(photo.calls, ['chassis']);
  assert.deepEqual(official.calls, ['official']);
});
