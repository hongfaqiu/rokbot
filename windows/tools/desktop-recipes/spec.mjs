// Changes to the official Windows, macOS, and Linux Grok Bot 1.3.0 app.asar, built into
// windows/patchers/desktop/recipes, mac/patchers/desktop/recipes, and
// linux/patchers/desktop/{x64,arm64}/recipes by build.mjs.
// Each anchor must occur exactly once in its source; a different official build is
// refused instead of being half patched. Code that the recipes append lives in
// extensions/ (it is the source, not dead code).
//
// Edits: { prepend | append | replaceAll: text }, { insertBefore | insertAfter: anchor, text },
// { replace: anchor, text }, { cutFrom: anchor, text } (drops the rest of the file),
// { removeThrough: [startAnchor, endAnchor], text }.
import { readFileSync } from 'node:fs';

const extension = name => readFileSync(new URL(`./extensions/${name}`, import.meta.url), 'utf8');
// The admin page's count formatter and usage charts, shipped to the settings (Usage section).
const publicFile = name => readFileSync(new URL(`../../../host/server/public/${name}`, import.meta.url), 'utf8');
const usageFormat = () => publicFile('usage-format.js');
// rok-usage-charts.js: usage-charts.js importing the renderer's copy of the formatter, with
// usage-charts.css as a string (the admin page links it; the settings add it in a <style>).
export function usageCharts() {
  const source = publicFile('usage-charts.js'), from = "from './usage-format.js';";
  if (source.split(from).length !== 2) throw new Error('usage-charts.js must import usage-format.js once');
  return source.replace(from, "from './rok-usage-format.js';") + `\nexport const ROK_USAGE_CHART_CSS = ${JSON.stringify(publicFile('usage-charts.css'))};\n`;
}
// rok-usage-dashboard.js: usage-dashboard.js importing the renderer's copies of both, with
// usage-dashboard.css as a string.
export function usageDashboard() {
  let source = publicFile('usage-dashboard.js');
  for (const [from, to] of [["from './usage-format.js';", "from './rok-usage-format.js';"], ["from './usage-charts.js';", "from './rok-usage-charts.js';"]]) {
    if (source.split(from).length !== 2) throw new Error(`usage-dashboard.js must import ${from} once`);
    source = source.replace(from, to);
  }
  return source + `\nexport const ROK_USAGE_DASHBOARD_CSS = ${JSON.stringify(publicFile('usage-dashboard.css'))};\n`;
}
const USAGE_FORMAT = "import { formatCount as rokFormatCount, formatExactCount as rokFormatExactCount, withRequestUnit as rokWithRequestUnit } from './rok-usage-format.js';\n"
  + "import { usageView as rokUsageView, attachUsageTooltip as rokAttachUsageTooltip, ROK_USAGE_CHART_CSS } from './rok-usage-charts.js';\n"
  + "import { mountUsageDashboard as rokMountUsageDashboard, ROK_USAGE_DASHBOARD_CSS } from './rok-usage-dashboard.js';\n";
const asset = name => `dist/renderer/assets/${name}`;
const edit = (name, edits) => ({ path: asset(name), source: asset(name), edits });
const I18N = "import { grokText } from './grok-local-i18n.js';\n";

export const TARGETS = Object.freeze({
  windows: Object.freeze({
    target: 'windows',
    version: '1.3.0',
    architecture: 'x64',
    label: 'Windows x64',
    recipesRelativeDir: 'windows/patchers/desktop/recipes',
    cacheRelativeDir: 'windows/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/win32-x64/1.3.0/Grok_Bot_1.3.0_Setup.exe',
      bytes: 128235976,
      sha256: '0a141fff67a43684e3a70469eb6d5b0455c40241eae34858d065061e7011f1b7',
    }),
    payload: Object.freeze({
      name: 'app-64.7z',
      bytes: 127310975,
      sha256: 'f56d738f0b5cd119827fdde706568f64a0bf3f021d2c81cf625960a96327cc72',
    }),
    asarSha256: '21f191ffb4858d9f4d8a57d56a3ce424b03a19b7d7b901530a50a92628ddd315',
    asarHeaderSha256: '6db588436982502a5ac83ac5c291b5fbca850f28a0117a2d28db9cda06b61bb0',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-DbVOwbnU.js',
      eagerCommon: 'index.eager-common-rGW_2t4Y.js',
      connectedApps: 'chunk-view-Ck6m2dRl.js',
      connectedAppsEmpty: 'chunk-view-CuDAGCFJ.js',
      library: 'chunk-bot-store-files-library-Buv97Hok.js',
      generalPane: 'chunk-general-pane-CZkpGQLQ.js',
      computerView: 'chunk-view-_JwVsmv_.js',
      updateView: 'chunk-view-BwAtZhGc.js',
      marketplaceModel: 'chunk-marketplace-browse-model-CWOU11f0.js',
      pluginDetail: 'chunk-plugin-detail-view-BuFNWAJl.js',
      eagerApp: 'index.eager-app-B8R_eIgV.js',
    }),
  }),
  mac: Object.freeze({
    target: 'mac',
    version: '1.3.0',
    bundleId: 'com.anysphere.sand',
    architecture: 'arm64',
    label: 'macOS arm64',
    recipesRelativeDir: 'mac/patchers/desktop/recipes',
    cacheRelativeDir: 'mac/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/darwin-arm64/1.3.0/Grok_Bot_1.3.0.dmg',
      bytes: 160753982,
      sha256: '85914908760b4503962ac9794622a16877657be77d5a2925ba99c2fc37d80a8c',
    }),
    asarSha256: 'e4ee91c221544516d2d774151eb6a10a76f100ac91b1293013221620cbb51a71',
    asarHeaderSha256: 'b7b40c35bd828e68787671a67bdb1e1e01e890112519e6196537efae2184314a',
    frameworkSha256: '2e13e33b1a95b44be5f7ebf19bb944b31b12bb90a5074a5e4ea1af6ea35680b6',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-CX49MNl7.js',
      eagerCommon: 'index.eager-common-rGW_2t4Y.js',
      connectedApps: 'chunk-view-BZhHf36f.js',
      connectedAppsEmpty: 'chunk-view-C2Tgre9F.js',
      library: 'chunk-bot-store-files-library-D69l2OSw.js',
      generalPane: 'chunk-general-pane-BYlQ0xzS.js',
      computerView: 'chunk-view-XovHfDRc.js',
      updateView: 'chunk-view-vZqeG1gy.js',
      marketplaceModel: 'chunk-marketplace-browse-model-C2vE2WYs.js',
      pluginDetail: 'chunk-plugin-detail-view-CV7-Z9ff.js',
      eagerApp: 'index.eager-app-BrdVnhlw.js',
    }),
  }),
  'linux-x64': Object.freeze({
    target: 'linux-x64',
    version: '1.3.0',
    architecture: 'x64',
    debArchitecture: 'amd64',
    label: 'Linux x64',
    recipesRelativeDir: 'linux/patchers/desktop/x64/recipes',
    cacheRelativeDir: 'linux/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/bfb372966cec77c6ec2750957965f2a2268da17d/linux/x64/grok-bot_1.3.0_amd64.deb',
      bytes: 117982212,
      sha256: '87b046b6e4126c3eb466df59135b59c8efbb5f9f10e0de548f0d65ec8ac55528',
    }),
    asarSha256: '9402c33f360945ecf12df664c5a035add0d0c5f7e386843d7c5866b2cf139485',
    asarHeaderSha256: 'ec66ffb734359856d82ab0bb3138819565b28b34c9e74b66c81545145a892f58',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-Chwq3-ME.js',
      eagerCommon: 'index.eager-common-rGW_2t4Y.js',
      connectedApps: 'chunk-view-CVx0r4LU.js',
      connectedAppsEmpty: 'chunk-view-C6R9HVP9.js',
      library: 'chunk-bot-store-files-library-ZUkhSB2s.js',
      generalPane: 'chunk-general-pane-DDHm5cE5.js',
      computerView: 'chunk-view-BlOLYXAt.js',
      updateView: 'chunk-view-C6r3bPYv.js',
      marketplaceModel: 'chunk-marketplace-browse-model-CErNOYtN.js',
      pluginDetail: 'chunk-plugin-detail-view-Q38AWWxL.js',
      eagerApp: 'index.eager-app-CIV_rOgf.js',
    }),
  }),
  'linux-arm64': Object.freeze({
    target: 'linux-arm64',
    version: '1.3.0',
    architecture: 'arm64',
    debArchitecture: 'arm64',
    label: 'Linux arm64',
    recipesRelativeDir: 'linux/patchers/desktop/arm64/recipes',
    cacheRelativeDir: 'linux/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/bfb372966cec77c6ec2750957965f2a2268da17d/linux/arm64/grok-bot_1.3.0_arm64.deb',
      bytes: 114013936,
      sha256: 'f9168a4a6182201a24977c18f42751cd964f8daf300289333c37c4f0baf40ed3',
    }),
    asarSha256: '1ff460cb559ba047f715990e1d29073d806f965e11c681a699a680e6af816cb6',
    asarHeaderSha256: '9ef17f3fe3e8ec7454ce4757131df261012c7a3e1f35cbed259a1c90f0f4f01b',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-BDHhjGY8.js',
      eagerCommon: 'index.eager-common-rGW_2t4Y.js',
      connectedApps: 'chunk-view-BELWKkQz.js',
      connectedAppsEmpty: 'chunk-view-DaCGfQc5.js',
      library: 'chunk-bot-store-files-library-DGqR0Q_x.js',
      generalPane: 'chunk-general-pane-BArjKVys.js',
      computerView: 'chunk-view-juNoUmx2.js',
      updateView: 'chunk-view-lRMTtlEF.js',
      marketplaceModel: 'chunk-marketplace-browse-model-F9CQJAcQ.js',
      pluginDetail: 'chunk-plugin-detail-view-DgAUY13Q.js',
      eagerApp: 'index.eager-app-DqvMmste.js',
    }),
  }),
});

export function targetMeta(target = 'windows') {
  const meta = TARGETS[target];
  if (!meta) throw new Error(`Unsupported recipe target: ${target}`);
  return meta;
}

export function specForTarget(target = 'windows') {
  const { chunks } = targetMeta(target);
  return [
    // The local client (mac/clients/desktop) reuses a few original main-process modules. Each
    // copy stops before the original entry point runs and exports what the client needs.
    {
      path: 'dist/electron-main/local-browser.cjs', source: 'dist/electron-main/main-app.cjs',
      edits: [
        { prepend: 'require("./local-shared.cjs");\n' },
        { cutFrom: 'var Wxt=y(Dy()),jxt=y(uxt()),be=(0,$xt.readMainCoreHandoff)();',
          text: '\nmodule.exports={requestPasskey:WKe,requestPin:VKe,updatePasskey:Mnn,finishPasskey:Dnn};\n' },
      ],
    },
    {
      path: 'dist/electron-main/local-shared.cjs', source: 'dist/electron-main/main-core.cjs',
      edits: [
        { cutFrom: 'p8({killSwitch:process.env.CURSOR_DISABLE_HALF_OPEN_ASYNC_ITERATOR_FIX});var BZ=eke(),CYe=S8({scope:"sand-desktop"});',
          text: '\nmodule.exports={activateLocale:BA};\n' },
      ],
    },
    {
      path: 'dist/local-exec-daemon/main.cjs', source: 'dist/local-exec-daemon/main.cjs',
      edits: [
        { removeThrough: ['pZt().catch(r=>{let e=r instanceof Error?r:new Error(String(r));process.stderr.write(`[sand-local-exec-daemon] fatal:',
          'finally(()=>process.exit(1))});'],
          text: `${extension('local-exec-transfer.js')}\nmodule.exports={Provider:rokbotEnhanceLocalExecProvider(Xx),ComputerUse:Zx,findComputerHelper:QUe,decideLocalUse:jK,isLocalUseBlocked:gEe,retireApproval:mEe,parseApproval:Uft};` },
      ],
    },
    {
      path: 'dist/node-agent-coordinator/local-browser.cjs', source: 'dist/node-agent-coordinator/main.cjs',
      edits: [
        { cutFrom: 'mbe().catch(n=>{process.stderr.write(`node-agent-coordinator: composition failure:',
          text: '\nmodule.exports={passkeyProvider:cW,signer:g5,findSigner:f5,relyingParty:pW,interval:Ds,reconnect:pbe,deadline:at,watchdog:oo,delivery:Kt,expiry:Vi};\n' },
      ],
    },

    { path: asset('grok-local-i18n.js'), source: null, edits: [{ append: extension('grok-local-i18n.js') }] },
    { path: asset('rok-usage-format.js'), source: null, edits: [{ append: usageFormat() }] },
    { path: asset('rok-usage-charts.js'), source: null, edits: [{ append: usageCharts() }] },
    { path: asset('rok-usage-dashboard.js'), source: null, edits: [{ append: usageDashboard() }] },

    // No crash reports leave the local client.
    edit(chunks.sentrySdk, [
      { replaceAll: 'const noop=()=>{};export function initSandSentrySdk(){return{captureException:noop,captureMessage:noop,setTag:noop,withScope:noop}}' },
    ]),
    edit(chunks.eagerCommon, [
      { insertBefore: 'if(Rt(e[0])){if(Nt.size===0)It({kind:`exception`,args:e})', text: 'return;' },
      { insertBefore: 'if(Nt.size===0)It({kind:`message`,args:e})', text: 'return;' },
    ]),

    // Connected apps: only apps the Host can serve, a local empty state and the Host's share link.
    edit(chunks.connectedApps, [
      { replace: 'c=r?n.filter(sl):n;', text: 'c=n.filter(sl);' },
      { replace: 'onSelect:()=>y(xn(D)),children:N', text: 'onSelect:()=>y(r.shareUrl),children:N' },
    ]),
    edit(chunks.connectedAppsEmpty, [
      { prepend: I18N },
      { replace: 'i=r({id:`kxskKD`})', text: 'i=grokText(`暂无连接应用`,`No connected apps`)' },
    ]),

    // Bot library: the Host accepts 20 MiB per file, 100 files and 100 MiB per Bot. Host Bots
    // keep one shared library and no per-user store; files can be picked as well as dropped.
    edit(chunks.library, [
      { prepend: `${I18N}import { eO as GrokButton } from './${chunks.eagerApp}';\n` },
      { replace: 'oe=26214400,k=1073741824', text: 'oe=20971520,k=104857600' },
      { replace: 'e.sizeBytes>26214400?{kind:`too-large`}:t.fileCount>=200?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>1073741824?',
        text: 'e.sizeBytes>20971520?{kind:`too-large`}:t.fileCount>=100?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>104857600?' },
      { replace: 'values:{limit:200,names:t}', text: 'values:{limit:100,names:t}' },
      { replace: 'let he;return t[57]!==J||t[58]!==$?(he=(0,V.jsxs)(V.Fragment,{children:[J,$]}),t[57]=J,t[58]=$,t[59]=he):he=t[59],he}',
        text: 'return(0,V.jsxs)(V.Fragment,{children:[k?(0,V.jsx)(GrokLibraryUpload,{upload:N,disabled:P}):null,$]})}' },
      { append: extension('library.js') },
    ]),

    // Settings > General: the account card shows this Host and opens the connection dialog;
    // model configuration & realtime voice are local settings; the Host's token usage per model;
    // no security key proxy (drop w=ba, keep T=bo).
    edit(chunks.generalPane, [
      { prepend: I18N },
      { prepend: USAGE_FORMAT },
      { replace: '(H=(0,$.jsx)(`span`,{className:V,children:z}),',
        text: '(H=typeof z==`string`?(0,$.jsx)(GrokAccountName,{className:V,name:z,onCommit:name=>n.updateName(name)}):(0,$.jsx)(`span`,{className:V,children:z}),' },
      { replace: '(oe=(0,$.jsx)(`span`,{className:U,children:A}),', text: '(oe=(0,$.jsx)(`span`,{className:U,children:(0,$.jsx)(GrokAccountHost,{})}),' },
      { replace: '(G=D?(0,$.jsx)(K,{disabled:P,onClick:c?()=>void n.cancelLoginFlight():()=>void s(),size:`md`,style:vr.actionWeakBorder,variant:`secondary`,children:c?(0,$.jsx)(Y,{id:`dEgA5A`}):(0,$.jsx)(Y,{id:`MPPZ54`})}):null,',
        text: '(G=(0,$.jsx)(GrokHostConnection,{}),' },
      // Notification sounds are a development-only section upstream; show it without DEV markers.
      { replace: ':(n=t?(0,$.jsx)($i,{}):null,', text: ':(n=(0,$.jsx)($i,{}),' },
      { replace: '(f=(0,$.jsx)(Mt,{children:d}),', text: '(f=d,' },
      { replace: 'label:x(n({id:`EJ5f2m`}))', text: 'label:n({id:`EJ5f2m`})' },
      { replace: '"aria-label":x(n({id:`FK/hQQ`}))', text: '"aria-label":n({id:`FK/hQQ`})' },
      // Auto-review: a short description, and no team-rule hints.
      { replace: '(g=a(l==null?{id:`De8ppO`}:{id:`QqKsGg`}),', text: '(g=l==null?grokText(`运行操作前检查，需要时询问。`,`Review actions and ask when needed.`):a({id:`QqKsGg`}),' },
      { replace: '(0,$.jsx)(Kn,{children:(0,$.jsx)(Y,{id:`NFRGrQ`})})', text: 'null' },
      { replace: '(0,$.jsx)(b,{as:`span`,color:`tertiary`,level:`sm`,children:h})]}):null', text: 'null]}):null' },
      { replace: 'children:[l,f,p,m,x,S,h,g,_,v,y,b,C,w,T,E,D]',
        text: 'children:[l,f,(0,$.jsx)(RokAvatarStyleSettings,{}),(0,$.jsx)(RokListArrangementSettings,{}),(0,$.jsx)(RokModelSettings,{}),(0,$.jsx)(RokUsageSettings,{}),(0,$.jsx)(GrokRealtimeVoiceSettings,{}),p,m,x,S,h,g,_,v,y,b,C,T,E,D]' },
      { append: extension('general-pane.js') },
    ]),

    // Settings > Computer: the Host manages the Bot's computer; this computer's access stays.
    edit(chunks.computerView, [
      { prepend: I18N },
      { replace: '(0,Q.jsxs)(`div`,{...n,children:[i,a,o,s]})', text: '(0,Q.jsxs)(`div`,{...n,children:[(0,Q.jsx)(GrokRemoteDesktop,{}),i,a,o]})' },
      { append: extension('computer-view.js') },
    ]),

    // Settings > Updates: RokBot 1.3.0 local version card (hooked by update-config.mjs & renderer-patches.mjs).
    edit(chunks.updateView, [
      { prepend: I18N },
      { replace: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(T,{})}),', text: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),' },
      { append: extension('update-view.js') },
    ]),

    // Marketplace: apps the Host provides form their own category without public links.
    edit(chunks.marketplaceModel, [
      { replace: 'var u=[`credentials`,', text: 'var u=[`host`,`credentials`,' },
      { replace: 'd={LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,', text: 'd={HOST:`host`,LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,' },
      { replace: 'var T={credentials:{id:`D1dENt`},', text: 'var T={host:{id:`Host`,message:`Host`},credentials:{id:`D1dENt`},' },
    ]),
    edit(chunks.pluginDetail, [
      { replace: 'function Vt(e,t){if(e.marketplace?.ownership===`user`)return null;',
        text: 'function Vt(e,t){if(e.category===`Host`)return null;if(e.marketplace?.ownership===`user`)return null;' },
    ]),

    edit(chunks.eagerApp, [
      { prepend: I18N },
      { replace: 'let f;e[5]===Symbol.for(`react.memo_cache_sentinel`)?(f=(0,Z.jsx)(bXr,{}),e[5]=f):f=e[5];',
        text: 'let f=(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(bXr,{}),(0,Z.jsx)(RokNeedsModelBanner,{}),(0,Z.jsx)(RokModelConfigHost,{}),(0,Z.jsx)(RokBatchImageHost,{}),(0,Z.jsx)(RokCanvasStageHost,{})]});' },
      // Canvases (extensions/canvas.js): a RokBot canvas link (`/canvas/app/<id>`) is an ordinary
      // link to the link classifier, and the link component draws it as a canvas card that opens
      // the canvas inside the app; Bot details list the Bot's canvases after its routines.
      { insertAfter: 'function H6n(e,t){', text: 'if(rokCanvasLinkId(e)!=null)return{kind:`external`};' },
      { replace: 'function CZ(e){CZ.d=1477;', text: 'function CZ(e){return rokCanvasLinkId(e.href)!=null?(0,Z.jsx)(RokCanvasLinkCard,e):(0,Z.jsx)(CZ_orig,e)}function CZ_orig(e){CZ_orig.d=1477;' },
      { replace: '(ge=(0,Z.jsxs)(`div`,{...ue,children:[de,fe,pe,me,he]})', text: '(ge=(0,Z.jsxs)(`div`,{...ue,children:[de,fe,pe,me,(0,Z.jsx)(RokBotCanvasSection,{agentId:n,headingId:`${y}-canvases`}),he]})' },
      // Multi-select batch image download: track resolved images per conversation; the entry sits in the
      // chat header (only while the conversation has images) and in the Media Viewer.
      { replace: 'resolveMedia:(n,r)=>e.desktop.resolveAttachmentMedia({...n,...t?{inRoom:t}:{},viewSlot:e.accountSlot},r)',
        text: 'resolveMedia:(n,r)=>rokTrackResolvedMedia(n,e.desktop.resolveAttachmentMedia({...n,...t?{inRoom:t}:{},viewSlot:e.accountSlot},r))' },
      { replace: 'await e.desktop.setViewingAgent({agentId:r,',
        text: 'rokSetActiveAgentId(r),await e.desktop.setViewingAgent({agentId:r,' },
      { replace: '(0,BS.createPortal)((0,Z.jsxs)(Z.Fragment,{children:[Ht,Bt]}),g.actionsSlot)',
        text: '(0,BS.createPortal)((0,Z.jsxs)(Z.Fragment,{children:[Ht,(0,Z.jsx)(RokMediaViewerBatchButton,{sources:n,captions:r,embedded:!0}),Bt]}),g.actionsSlot)' },
      { replace: 'children:[Bt,(0,Z.jsx)(IC,{"aria-label":p({id:`bpMYYF`}),className:`sand-media-viewer__close`',
        text: 'children:[(0,Z.jsx)(RokMediaViewerBatchButton,{sources:n,captions:r,embedded:!1}),Bt,(0,Z.jsx)(IC,{"aria-label":p({id:`bpMYYF`}),className:`sand-media-viewer__close`' },
      { replace: 'children:[m==null?null:(0,Z.jsx)(l3n,{...m}),(0,Z.jsx)(G2,{agentId:n.id}),',
        text: 'children:[m==null?null:(0,Z.jsx)(l3n,{...m}),(0,Z.jsx)(G2,{agentId:n.id}),(0,Z.jsx)(RokChatHeaderBatchButton,{agentId:n.id}),' },
      { replace: 'VU={FEATURED:{id:`FkMol5`},', text: 'VU={HOST:{id:`Host`,message:`Host`},FEATURED:{id:`FkMol5`},' },
      // Account menu: connection settings instead of adding a cloud account; no mobile app offer.
      { replace: '(et=(0,Z.jsxs)(Rw.Section,{children:[Ye,Xe,$e]}),', text: '(et=(0,Z.jsxs)(Rw.Section,{children:[Xe,$e]}),' },
      { replace: 'onSelect:ze,children:(0,Z.jsx)($o,{id:`MPPZ54`})}):null,',
        text: 'onSelect:()=>{window.__grokLocalConnectionRequested=true;c(`general`);window.dispatchEvent(new Event(`grokbot-local:connect-request`))},children:grokText(`连接设置`,`Connection settings`)}):null,' },
      // Signing out disconnects from the Host; nothing stays on a cloud computer.
      { replace: 'description:toe(e)===null?xi._({id:`5qRD8O`}):xi._({id:`W51kAS`})', text: 'description:``' },
      // Bot settings: title, instructions and library files are kept on the Host; the Host
      // chooses the voice, so neither the Bot nor a call offers voice settings.
      { replace: 'return t[26]!==v||t[27]!==y?(b=(0,Z.jsxs)(`div`,{className:c,children:[v,y]}),t[26]=v,t[27]=y,t[28]=b):b=t[28],b',
        text: 'return t[26]!==v||t[27]!==y?(b=(0,Z.jsxs)(`div`,{className:c,children:[v,y,(0,Z.jsx)(GrokLocalSettings,{agent:n})]}),t[26]=v,t[27]=y,t[28]=b):b=t[28],b' },
      { insertAfter: 'function dP(e){', text: 'return null;' },
      // No crash reporter, heap samples or idle sampling.
      { insertAfter: 'function Het(e,t,n=Vet){', text: 'return{load:async()=>{},setTag:()=>{}};' },
      { insertAfter: 'function Efi(e,t,n={}){', text: 'return()=>{};' },
      { insertAfter: 'function Nfi(e,t=document){', text: 'return{sampleIdleMinutes:()=>void 0,stop:()=>{}};' },
      // Realtime calls go to the Host relay (host/server/voice-session.mjs).
      { replace: 'ce=(t,n)=>e.source.setVoiceCallPresence({id:t.agentId,callId:t.callId,isOnTheLine:n,acceptsOverheard:t.acceptsOverheard})',
        text: 'ce=(t,n)=>Promise.resolve()' },
      { insertAfter: 'Te=async(t,n,r,i)=>{if(!hY.canHangUp(t.phase))return;', text: 'n===`hung-up`&&t.session?.localVoiceEndCall?.();' },
      { replace: 'P=e=>e.didConnect?(e.journalLine??=', text: 'P=e=>!1?(e.journalLine??=' },
      { insertBefore: 'let n=A();if(n===null||n.phase===`ending`||n.agentId!==t.agentId||n.callId!==t.callId', text: 'return;' },
      { insertBefore: 'let i=A();if(i===null||!hY.isCallerOnTheLine(i.phase)||i.agentId!==t||n!==i.thread.sessionId)return;Oe(i,r);', text: 'return;' },
      // Turning realtime voice off in Settings ends the current call.
      { insertAfter: 'je=e.transcript.observeEntriesFeed({onAppended:ke,onBaseline:Ae,onFetched:({agentId:e,sessionId:t,read:n})=>Ae({agentId:e,sessionId:t,entries:n})})',
        text: ',grokVoicePreferenceRelease=window.localBot.onVoicePreferenceChanged(enabled=>{enabled||void te()})' },
      { replace: 'dispose(){je();', text: 'dispose(){grokVoicePreferenceRelease(),je();' },
      // The local client mints a short-lived ticket for this Host; only that address is dialable.
      { replace: 'let r=await e.desktop.mintVoiceCallCredential();',
        text: 'let r=await window.localBot.mintVoiceCredential(this.dial.agentId);grokVoiceEndpoint=r.ok?r.credential.websocketUrl:null;' },
      { replace: 'function Edi(e){return Tdi(e.desktop,wdi(e))}',
        text: 'function Edi(e){return{session:async()=>({instructions:``,tools:[],hasOverheard:!1,greeting:{direction:``,withLandedWork:``}}),callTool:async()=>{throw Error(`Voice tools are managed by the Host`)}}}' },
      { replace: 'var ihi=class e{static DIALABLE_ORIGIN=`wss://api.x.ai/`;static isDialableURL(t){return t.startsWith(e.DIALABLE_ORIGIN)}',
        text: 'let grokVoiceEndpoint=null;var ihi=class e{static isDialableURL(t){return typeof t==`string`&&t===grokVoiceEndpoint}' },
      // Speech plays through a media element, and the Host hears playback.done & session.close.
      { replace: 'let s=r.createMediaStreamDestination(),c=new e(r,a,o,s,t);return c.hold(n,i),c}',
        text: 'let s=r.createMediaStreamDestination(),speaker=new Audio;speaker.autoplay=!0,speaker.srcObject=s.stream,await speaker.play();let c=new e(r,a,o,s,t);return c.localOutput=speaker,c.hold(n,i),c}' },
      { replace: 'n.connect(this.context.destination),n.connect(this.speakerTap);', text: 'n.connect(this.speakerTap);' },
      { replace: 'teardown(){this.dropScheduledSpeech(),', text: 'teardown(){this.localOutput?.pause(),this.localOutput&&(this.localOutput.srcObject=null),this.dropScheduledSpeech(),' },
      { replace: 'responseHeard=[];socket;router;responses;', text: 'responseHeard=[];localVoiceHeard=new Set;localVoiceGeneration=0;socket;router;responses;' },
      { replace: 'onCallerInterrupted:()=>{this.cancelUserFirstOpen(),', text: 'onCallerInterrupted:()=>{this.localVoiceGeneration++,this.localVoiceHeard.clear(),this.cancelUserFirstOpen(),' },
      { replace: 'onAssistantResponseEnded:e=>{this.sendTruncations(', text: 'onAssistantResponseEnded:e=>{e||void this.localVoicePlaybackDone(),this.sendTruncations(' },
      { replace: 't.speak(e,this.responses.speaksForNudgeId),this.args.handlers.onAudioReceived?.()',
        text: 't.speak(e,this.responses.speaksForNudgeId),e.itemId!==null&&this.localVoiceHeard.add(e.itemId),this.args.handlers.onAudioReceived?.()' },
      { insertAfter: 'thisResponseHasBeenHeard(){for(let e of this.responseHeard.splice(0))e()}',
        text: 'async localVoicePlaybackDone(){let items=[...this.localVoiceHeard],generation=this.localVoiceGeneration,audio=this.audio;if(audio===null||items.length===0)return;try{await audio.whenScheduledSpeechEnds()}catch{return}if(this.phase.kind!==`live`||generation!==this.localVoiceGeneration||this.router.callerIsSpeaking||this.socketSilentlyDiscardsFrames())return;for(let item_id of items)this.socket.send(JSON.stringify({type:`response.playback.done`,item_id}));this.localVoiceHeard.clear()}localVoiceEndCall(){this.socketSilentlyDiscardsFrames()||this.socket.send(JSON.stringify({type:`session.close`}))}' },
      { replace: 't.kind===`event`&&this.router.route(t.event)',
        text: 't.kind===`event`&&((t.event.type===`response.created`||t.event.type===`response.cancelled`)&&(this.localVoiceGeneration++,this.localVoiceHeard.clear()),this.router.route(t.event))' },
      { replace: 'openAfterUserFirstGrace(){let e=this.pendingConnectGreeting;e!==null&&(this.pendingConnectGreeting=null,this.responses.greet(e))}',
        text: 'openAfterUserFirstGrace(){this.cancelUserFirstOpen()}' },
      { replace: 'resumption:{enabled:!0}', text: 'resumption:{enabled:!1}' },
      { append: `\nconst ROK_LIBRARY_CHUNK = './${chunks.library}';\nconst ROK_GENERAL_PANE_CHUNK = './${chunks.generalPane}';\n` },
      // Session list arrangement: "activity" ranks Bots on their last message in the groups
      // waiting on you / unread / read (extensions/list-arrangement.js). The generated groups
      // are sections the user cannot rename or delete, and open cards also mark a row.
      { replace: 'let{visibleAgents:ie,hiddenAgents:ae}=re,oe;',
        text: 'let{visibleAgents:ie,hiddenAgents:ae}=re,oe;({visibleAgents:ie,sidebarSections:A,setSectionCollapsed:P,editSections:j}=RokUseArrangedSidebar({visibleAgents:ie,sidebarSections:A,setSectionCollapsed:P,editSections:j}));' },
      { replace: 'isSynthetic:e.id===Cd,', text: 'isSynthetic:e.id===Cd||rokListIsGroupId(e.id),' },
      { replace: 'function MTt(e,t){let n=null;return e.awaitingUserResponse==null?',
        text: 'function MTt(e,t){let n=null;return e.awaitingUserResponse==null&&e.pendingAction==null?' },
      // The wind chime toggle sits left of Search in the list header (Web phones: left of the
      // Search field, web/client/android.css).
      { replace: ':null,p,f==null?(0,Z.jsx)(le,{content:g({id:`2hjDEV`})',
        text: ':null,(0,Z.jsx)(RokListModeButton,{}),p,f==null?(0,Z.jsx)(le,{content:g({id:`2hjDEV`})' },
      // A generated group has no section menu: it cannot be renamed, moved or deleted.
      { replace: 'De=(0,Z.jsxs)(zw,{children:[ue,Ee]})', text: 'De=(0,Z.jsxs)(zw,{children:[ue,rokListIsGroupId(n.id)?null:Ee]})' },
      // It is neither dragged (only the drag listeners are left off, so the header stays an
      // enabled fold button) nor a drop target for Bots: the order comes from the messages.
      { replace: 'let le=o?void 0:j,ue;', text: 'let le=o||rokListIsGroupId(n.id)?void 0:j,ue;' },
      { replace: 'P={id:O.dndId,data:O.payload}', text: 'P={id:O.dndId,data:O.payload,disabled:rokListIsGroupId(n.id)}' },
      // Bot avatar style: RokBot dynamic styles by default, with user-selectable style including official.
      { replace: 'function bT(e){bT.d=3834;',
        text: 'function bT(e){return RokUseAvatarStyle()===`official`?(0,Z.jsx)(bT_orig,e):(0,Z.jsx)(RokGrokBotMark,e)}function bT_orig(e){bT_orig.d=3834;' },
      { replace: 'function xT(e){xT.d=3835;',
        text: 'function xT(e){return RokUseAvatarStyle()===`official`?(0,Z.jsx)(xT_orig,e):(0,Z.jsx)(RokGrokBotMarkMirror,e)}function xT_orig(e){xT_orig.d=3835;' },
      // Static Bot avatars (GO with isStatic, its default): the "+ New group chat"
      // recipient picker, its footer marks and chips, mentions and other small lists draw
      // the official still mark as an <img> instead of the GrokBotMark (bT), so the
      // RokBot style above never reached them. Unless the style is "official", a Bot
      // without its own picture now takes the paused bT path like the sidebar does; a
      // custom picture (dataUrl) still renders as that picture. The style hook is
      // read unconditionally at the top so the hook order never changes.
      { replace: 'function GO(e){GO.d=133;',
        text: 'function GO(e){let rokStyledStill=RokUseAvatarStyle()!==`official`;GO.d=133;' },
      { replace: 'if(A!=null||g&&!v){', text: 'if(A!=null||g&&!v&&!rokStyledStill){' },
      { append: extension('eager-app.js') },
      { append: extension('list-arrangement.js') },
      { append: extension('avatar-style.js') },
      { append: extension('batch-image-download.js') },
      { append: extension('canvas.js') },
    ]),

    // The render-trace hook installs a React DevTools stub for the vendor's render sampling.
    { path: 'dist/renderer/index.html', source: 'dist/renderer/index.html', edits: [
      { replace: '    <script src="./assets/dune-render-trace-hook-265eb7be.js"></script>\n', text: '' },
    ] },
  ];
}

export const SPEC = specForTarget('windows');
