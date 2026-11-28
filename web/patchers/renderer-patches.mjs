// Android changes to the original renderer, applied after the desktop recipes, per
// Windows release the interface is taken from. `input` distinguishes a Windows recipe
// output from an untouched installer asset. Each target file is verified by SHA-256
// first, and every anchor must occur exactly once, so a different official build is
// refused instead of being half patched.
import { createHash } from 'node:crypto';

// The conversation details pane (Bot computer, files, skills) opens only when the window can
// hold sidebar + chat + pane side by side, and otherwise asks the desktop to widen the window.
// A phone cannot widen; there the pane opens as a full-screen layer instead (android.css).
// "Teach a task" records the desktop screen, which a phone cannot provide; the composer gets
// no teach action, as on platforms without recording. "Get Grok Bot for mobile" advertises the
// official phone apps of the cloud service. Like the official phone app, a Bot row shows when
// the Bot was last active (the time slot is otherwise unused in the list); client/layout.js
// formats the time.
// The Bot computer view is laid over its placeholder with CSS anchor positioning, which
// WebView builds before Chromium 125 drop. The same values are also kept as custom
// properties, which client/anchor-fallback.js resolves on those builds.
const ACTIVITY_TIME = name => `${name}=${name}??globalThis.rokbotActivityTime?.(`;
const anchorKeep = inset => inset.map(([name, value]) => `"--rokbot-anchor-${name}":${value}`).join(',');

export const RENDERER_PATCHES = {
  '1.3.0': [
    {
      file: 'assets/index.eager-app-B8R_eIgV.js',
      input: 'windows-recipe',
      sha256: 'b3c019b9a0ac719f6abecaaea4860cf2a96b07c68faf877a39ada1932100c8ad',
      edits: [
        ['function jE(e){return e.windowWidth>=zlt(e.sidebar,280)}', 'function jE(e){return!0}'],
        ['function Blt(e){return Math.max(0,zlt(e.sidebar,280)-e.windowWidth)}', 'function Blt(e){return 0}'],
        ['function Vlt(e){let t=e.expandedWidth+424+(e.openInfoPaneWidth??0);return Math.max(0,t-e.windowWidth)}', 'function Vlt(e){return 0}'],
        ['(oe=N==null?{}:{onTeachClick:N},', '(oe={},'],
        ['let Jt=o.isRosterTabStop?0:-1,Yt;n[123]===He?Yt=n[124]:(Yt=He?(0,Z.jsx)(sEt,{}):null,n[123]=He,n[124]=Yt);',
          'let Jt=o.isRosterTabStop?0:-1,Yt;n[123]===He?Yt=n[124]:(Yt=He?(0,Z.jsx)(sEt,{}):null,n[123]=He,n[124]=Yt);' +
          `${ACTIVITY_TIME('Yt')}r.lastActivityAt)??null;`],
      ],
    },
    {
      file: 'assets/chunk-computer-screen-preview-CROh3_te.js',
      input: 'original',
      sha256: '87613fe561c76f41db8b7b6b568f35c41717279dcc71133a88a8cc9a3f93c3c9',
      edits: [
        ['var xe={positionAnchor:u,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`},' +
          'Se={positionAnchor:E,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`},',
        'var xe={positionAnchor:u,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['right', '`anchor(right)`'], ['bottom', '`anchor(bottom)`'], ['left', '`anchor(left)`']]) + '},' +
          'Se={positionAnchor:E,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['left', '`anchor(left)`'], ['width', '`anchor-size(width)`'], ['height', '`anchor-size(height)`']]) + '},'],
      ],
    },
    {
      file: 'assets/chunk-view-BwAtZhGc.js',
      input: 'windows-recipe',
      sha256: 'f3a607b673d964fcd3c92188bbcb04f2372ce420f01d1b99e25e9c235ea79715',
      edits: [
        ['function D(){D.d=3030;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
          'function D(){D.d=3030;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:globalThis.__rokbotAndroidBoot?.updateStatus?.delivery==="in-app"?(0,x.jsx)(T,{}):(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}'],
      ],
    },
  ],
  '1.2.3': [
    {
      file: 'assets/index.eager-app-DodVIpEt.js',
      input: 'windows-recipe',
      sha256: 'a124d43c995182152ab4c4c8e3e3d52673d7fba8bb5484799bfc08afbe9d9347',
      edits: [
        ['function kE(e){return e.windowWidth>=Nrt(e.sidebar,280)}', 'function kE(e){return!0}'],
        ['function Prt(e){return Math.max(0,Nrt(e.sidebar,280)-e.windowWidth)}', 'function Prt(e){return 0}'],
        ['function Frt(e){let t=e.expandedWidth+424+(e.openInfoPaneWidth??0);return Math.max(0,t-e.windowWidth)}', 'function Frt(e){return 0}'],
        ['(ae=M==null?{}:{onTeachClick:M},', '(ae={},'],
        ['let Xt=o.isRosterTabStop?0:-1,Zt;n[123]===We?Zt=n[124]:(Zt=We?(0,Z.jsx)(hvt,{}):null,n[123]=We,n[124]=Zt);',
          'let Xt=o.isRosterTabStop?0:-1,Zt;n[123]===We?Zt=n[124]:(Zt=We?(0,Z.jsx)(hvt,{}):null,n[123]=We,n[124]=Zt);' +
          `${ACTIVITY_TIME('Zt')}r.lastActivityAt)??null;`],
      ],
    },
    {
      file: 'assets/chunk-computer-screen-preview-D0gd83rN.js',
      input: 'original',
      sha256: '25396e2bd1f3e67a60c372c99770fc26e5e83996e95e4ab8f8eedc6817dc617e',
      edits: [
        ['var _e={positionAnchor:l,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`},' +
          'q={positionAnchor:D,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`},',
        'var _e={positionAnchor:l,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['right', '`anchor(right)`'], ['bottom', '`anchor(bottom)`'], ['left', '`anchor(left)`']]) + '},' +
          'q={positionAnchor:D,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['left', '`anchor(left)`'], ['width', '`anchor-size(width)`'], ['height', '`anchor-size(height)`']]) + '},'],
      ],
    },
    {
      file: 'assets/chunk-view-xV8CbwrQ.js',
      input: 'windows-recipe',
      sha256: '2e224d65d992b3b59985583b37e9081806e44a99666ba1158bd46e9922b33e5c',
      edits: [
        ['function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
          'function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:globalThis.__rokbotAndroidBoot?.updateStatus?.delivery==="in-app"?(0,x.jsx)(T,{}):(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}'],
      ],
    },
  ],
  '1.1.0': [
    {
      file: 'assets/index.eager-app-BwKPFs1J.js',
      input: 'windows-recipe',
      sha256: 'ef025b0fc57ec9aa16425bd0511b7285786a753fe427b15f1d8ba5fbf9d7a500',
      edits: [
        ['function YD(e){return e.windowWidth>=Wat(e.sidebar,280)}', 'function YD(e){return!0}'],
        ['function Gat(e){return Math.max(0,Wat(e.sidebar,280)-e.windowWidth)}', 'function Gat(e){return 0}'],
        ['function Kat(e){let t=e.expandedWidth+424+(e.openInfoPaneWidth??0);return Math.max(0,t-e.windowWidth)}', 'function Kat(e){return 0}'],
        ['(ie=j==null?{}:{onTeachClick:j},', '(ie={},'],
        ['(lt=(0,Z.jsx)(aE.Item,{leading:st,onSelect:Me,children:ct}),', '(lt=null,'],
        ['let Xt=o.isRosterTabStop?0:-1,Zt;n[125]===Ue?Zt=n[126]:(Zt=Ue?(0,Z.jsx)(Jvt,{}):null,n[125]=Ue,n[126]=Zt);',
          'let Xt=o.isRosterTabStop?0:-1,Zt;n[125]===Ue?Zt=n[126]:(Zt=Ue?(0,Z.jsx)(Jvt,{}):null,n[125]=Ue,n[126]=Zt);' +
          `${ACTIVITY_TIME('Zt')}r.lastActivityAt)??null;`],
      ],
    },
    {
      file: 'assets/chunk-computer-screen-preview-DUJrLdj0.js',
      input: 'original',
      sha256: 'e1b0ac5591da90e1a65f75af4d5e33e55fac66d6b47d42e37365a217c9d3ae18',
      edits: [
        ['var _e={positionAnchor:p,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`},' +
          'q={positionAnchor:d,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`},',
        'var _e={positionAnchor:p,top:`anchor(top)`,right:`anchor(right)`,bottom:`anchor(bottom)`,left:`anchor(left)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['right', '`anchor(right)`'], ['bottom', '`anchor(bottom)`'], ['left', '`anchor(left)`']]) + '},' +
          'q={positionAnchor:d,top:`anchor(top)`,left:`anchor(left)`,width:`anchor-size(width)`,height:`anchor-size(height)`,' +
          anchorKeep([['top', '`anchor(top)`'], ['left', '`anchor(left)`'], ['width', '`anchor-size(width)`'], ['height', '`anchor-size(height)`']]) + '},'],
      ],
    },
    {
      file: 'assets/chunk-view-D18ZK0A2.js',
      input: 'windows-recipe',
      sha256: '312401e0b66da5233af3b4ed2a9f8aa7ffdc9676786517d30883672d49ae49fa',
      edits: [
        ['function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
          'function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:globalThis.__rokbotAndroidBoot?.updateStatus?.delivery==="in-app"?(0,S.jsx)(E,{}):(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}'],
      ],
    },
  ],
  '0.71.2': [
    {
      file: 'assets/index.eager-app-CrGjYQbA.js',
      input: 'windows-recipe',
      sha256: 'f17c145c7816c898432e143bf8f8185c93d8b3fe1d881948c6e3af73931123cd',
      edits: [
        ['function HUe(e){return e.windowWidth>=IR(e.sidebar,bi)}', 'function HUe(e){return!0}'],
        ['function qUe(e){return Math.max(0,IR(e.sidebar,bi)-e.windowWidth)}', 'function qUe(e){return 0}'],
        ['function jUe(e){const t=e.expandedWidth+il+(e.openInfoPaneWidth??0);return Math.max(0,t-e.windowWidth)}', 'function jUe(e){return 0}'],
      ],
    },
    {
      file: 'assets/index-CUXtfEUp.js',
      input: 'windows-recipe',
      sha256: '6e08e299755840bc1488a032180a9117578d5ddeda8b0c99ab6fde6a062f759c',
      edits: [
        ['(tl=j==null?{}:{onTeachClick:j},', '(tl={},'],
        ['(Ee=r.jsx(vt.Item,{leading:je,onSelect:se,children:Se}),', '(Ee=null,'],
        ['let tn;n[121]!==Ue?(tn=Ue?r.jsx(GD,{}):null,n[121]=Ue,n[122]=tn):tn=n[122];',
          'let tn;n[121]!==Ue?(tn=Ue?r.jsx(GD,{}):null,n[121]=Ue,n[122]=tn):tn=n[122];' +
          `${ACTIVITY_TIME('tn')}s.lastActivityAt)??null;`],
      ],
    },
    {
      file: 'assets/chunk-computer-screen-preview-BnTMKGxa.js',
      input: 'original',
      sha256: '9ab8a5dd6cd20fc732d466ca20ae861dd3d17d5471db99fa7a821e39ba2d75af',
      edits: [
        ['const Ce={positionAnchor:se,top:"anchor(top)",right:"anchor(right)",bottom:"anchor(bottom)",left:"anchor(left)"},' +
          'Gs={positionAnchor:Qs,top:"anchor(top)",left:"anchor(left)",width:"anchor-size(width)",height:"anchor-size(height)"},',
        'const Ce={positionAnchor:se,top:"anchor(top)",right:"anchor(right)",bottom:"anchor(bottom)",left:"anchor(left)",' +
          anchorKeep([['top', '"anchor(top)"'], ['right', '"anchor(right)"'], ['bottom', '"anchor(bottom)"'], ['left', '"anchor(left)"']]) + '},' +
          'Gs={positionAnchor:Qs,top:"anchor(top)",left:"anchor(left)",width:"anchor-size(width)",height:"anchor-size(height)",' +
          anchorKeep([['top', '"anchor(top)"'], ['left', '"anchor(left)"'], ['width', '"anchor-size(width)"'], ['height', '"anchor-size(height)"']]) + '},'],
      ],
    },
    {
      file: 'assets/chunk-view-BZxQ9Ylk.js',
      input: 'windows-recipe',
      sha256: 'a5423ee6ba0b931a43e8e1d59c36f669ddf8b787242e5080193ef46562cc44e5',
      edits: [
        ['function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
          'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:globalThis.__rokbotAndroidBoot?.updateStatus?.delivery==="in-app"?o.jsx(GrokOriginalUpdateSettings,{}):o.jsx(ie,{})}),t[0]=e):e=t[0],e}'],
      ],
    },
  ],
};

/** The renderer patches for the interface of one Windows release. */
export function rendererPatches(version) {
  const patches = RENDERER_PATCHES[version];
  if (!patches) throw new Error(`没有 Windows ${version} 界面的 Android 补丁。`);
  return patches;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Resolve all edits against the same pinned input, never against another edit's output. */
export function applyPinnedRendererPatch({ file, sha256, edits }, bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (sha(source) !== sha256) throw new Error(`界面文件与支持的版本不一致：${file}`);
  if (!edits.length) throw new Error(`界面补丁没有修改：${file}`);
  const spans = edits.map(([from, to], i) => {
    const anchor = Buffer.from(from);
    const at = source.indexOf(anchor);
    if (!anchor.length || at < 0) throw new Error(`界面补丁缺少锚点：${file} (#${i + 1})`);
    if (source.indexOf(anchor, at + 1) >= 0) throw new Error(`界面补丁锚点不唯一：${file} (#${i + 1})`);
    const replacement = Buffer.from(to);
    if (anchor.equals(replacement)) throw new Error(`界面补丁没有修改：${file} (#${i + 1})`);
    return { at, end: at + anchor.length, replacement, edit: i + 1 };
  }).sort((a, b) => a.at - b.at);

  let end = 0;
  const parts = [];
  for (const span of spans) {
    if (span.at < end) throw new Error(`界面补丁锚点重叠：${file} (#${span.edit})`);
    parts.push(source.subarray(end, span.at), span.replacement);
    end = span.end;
  }
  parts.push(source.subarray(end));
  return Buffer.concat(parts);
}

/** Returns the patched bytes of `name` for the interface of `version`, or null when the file has no Android patch. */
export function patchRendererFile(name, bytes, version) {
  const patch = rendererPatches(version).find(item => item.file === name);
  return patch ? applyPinnedRendererPatch(patch, bytes) : null;
}
