import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createContentPolicy} from '@saga-a2ui/react-mcp-stack/content-policy';
import {viewUriForHtml} from '@saga-a2ui/react-mcp-stack/server';
import {chromium, type Frame, type Page} from '@playwright/test';
import {build, preview} from 'vite';
import {createHttpServer as createBaseHttpServer} from '../src/node/http-server.ts';
import {stampHtmlRevision} from '../src/server/operation-log.ts';
import {VIEW_FILENAME} from '../src/server/view-artifact.ts';
import {ANSWER_A, ANSWER_B, ANSWER_C, ANSWER_HOSTILE, ATTRIBUTION_CASES, QUESTION_A, QUESTION_B} from './react-answers.ts';

const root = new URL('./', import.meta.url).pathname;
const out = new URL('../test-results/browser/', import.meta.url).pathname;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const html = fs.readFileSync(new URL('../dist/view.html', import.meta.url), 'utf8');
fs.mkdirSync(out, {recursive: true});

const WAITING_TEXT = 'Waiting for Ansari answer…';
const UNSUPPORTED_TEXT = 'This result could not be displayed.';
const SANDBOX = 'allow-scripts';
const ANSWERS: Record<string, string> = {[QUESTION_A]: ANSWER_A, [QUESTION_B]: ANSWER_B, 'Question C': ANSWER_C, 'Question hostile': ANSWER_HOSTILE, ...Object.fromEntries(ATTRIBUTION_CASES.map(c => [c.question, c.markdown]))};

const checks: {name: string; pass: true}[] = [];
const errors: string[] = [];
const ports: number[] = [];
const evidence: Record<string, unknown> = {};
const check = (name: string, f: () => void) => { f(); checks.push({name, pass: true}); if (process.env.REACT_BROWSER_TRACE) console.error('ok', name); };

let browser: any, host: any, child: any, service: any, mcpClient: Client | undefined;
const served = new Map<string, string>();
const requests: {url: string; from: string}[] = [];

async function main() {
  await build({configFile: false, root: `${root}/host`, logLevel: 'error', build: {target: 'esnext', outDir: `${out}/host`, emptyOutDir: true}});
  host = await preview({configFile: false, root: `${root}/host`, logLevel: 'error', build: {outDir: `${out}/host`}, preview: {host: '127.0.0.1', port: 0}});
  ports.push(host.httpServer.address().port);
  child = http.createServer((req, res) => {
    const body = served.get(req.url!);
    if (body === undefined) { res.writeHead(404).end(); return; }
    // Hosts may disallow font URLs, including data: and blob:, independently of our embedded policy.
    res.writeHead(200, {'content-type': 'text/html', 'content-security-policy': "font-src 'self'"}).end(body);
  });
  await new Promise<void>(r => child.listen(0, '127.0.0.1', r));
  ports.push(child.address().port);

  const logs: any[] = [];
  service = createBaseHttpServer({
    html, allowedHosts: ['127.0.0.1'], enableJsonResponse: true, logger: r => logs.push(r),
    completer: {async complete({question}) { if (question === 'FAIL') throw new Error('PRIVATE_CANARY'); return ANSWERS[question] ?? `Synthetic answer for ${question}.`; }},
  });
  await new Promise<void>(r => service.server.listen(0, '127.0.0.1', r));
  const mcpPort = (service.server.address() as any).port;
  ports.push(mcpPort);
  const client = new Client({name: 'react-qualification', version: '0'});
  mcpClient = client;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
  await client.connect(transport);

  // ---- The served resource: exact bytes, identity, resource rules ---------------------------------
  const viewUri = viewUriForHtml(stampHtmlRevision(html), VIEW_FILENAME);
  const resource = await client.readResource({uri: viewUri});
  const bytes = String((resource.contents[0] as {text: string}).text);
  check('resource:exact-served-bytes', () => assert.equal(bytes, stampHtmlRevision(html)));
  check('resource:uri-is-sha256-fingerprint-of-served-bytes', () => assert.equal(viewUri, `ui://views/${VIEW_FILENAME.replace(/\.html$/, '')}.${sha(bytes).slice(0, 32)}.html`));
  const meta = (resource.contents[0] as any)._meta;
  check('resource:closed-csp-no-origins', () => assert.deepEqual(meta.ui.csp, {connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: []}));
  const callTool = (question: string) => client.callTool({name: 'ask_ansari', arguments: {question}});
  const resultA = await callTool(QUESTION_A);
  const resultB = await callTool(QUESTION_B);
  const resultC = await callTool('Question C');
  const resultHostile = await callTool('Question hostile');
  const failure = await callTool('FAIL');
  check('results:linked-to-served-view', () => {
    for (const r of [resultA, resultB, resultC, resultHostile, failure]) assert.deepEqual(r._meta, {ui: {resourceUri: viewUri}});
  });
  check('results:structured-answers-unchanged', () => {
    assert.deepEqual(resultA.structuredContent, {version: '0.1.0', question: QUESTION_A, answer: ANSWER_A});
    assert.deepEqual(resultB.structuredContent, {version: '0.1.0', question: QUESTION_B, answer: ANSWER_B});
  });
  check('results:error-is-safe', () => { assert.equal(failure.isError, true); assert.ok(!JSON.stringify([failure, logs]).includes('PRIVATE_CANARY')); });

  browser = await chromium.launch({headless: true});
  const context = await browser.newContext();
  // tsx wraps named functions in __name(); evaluated page functions must find it in every frame.
  await context.addInitScript('window.__name = (f) => f;');
  const page: Page = await context.newPage();
  // Every iframe stays inside the viewport: an off-screen cross-origin frame has throttled animation frames.
  await page.setViewportSize({width: 1700, height: 9000});
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // Runtime networking is unavailable to the view: only the host fixture and the view document are reachable.
  const allowedOrigins = () => [`http://127.0.0.1:${ports[0]}`, `http://127.0.0.1:${ports[1]}`];
  await context.route('**/*', (route: any) => {
    const url = route.request().url();
    const frame = route.request().frame();
    const isView = frame !== null && frame !== page.mainFrame();
    if (url.startsWith('data:') || url.startsWith('blob:') || allowedOrigins().some(origin => url.startsWith(origin))) { route.continue(); return; }
    requests.push({url, from: isView ? 'view' : 'host'});
    route.abort();
  });
  page.on('request', r => { if (!r.url().startsWith('data:')) requests.push({url: r.url(), from: r.frame() === page.mainFrame() ? 'host' : 'view'}); });
  await page.goto(host.resolvedUrls.local[0]);
  await page.waitForFunction(() => (window as any).hostProbe);

  let counter = 0;
  async function openView(width = 760, height = 900, document = bytes, openLinks = true): Promise<{id: string; frame: Frame}> {
    const id = `view${++counter}`;
    const path = `/${id}`;
    served.set(path, document);
    await page.evaluate(({id, url, sandbox, openLinks}) => (window as any).hostProbe.create(id, url, true, sandbox, openLinks), {id, url: `http://127.0.0.1:${ports[1]}${path}`, sandbox: SANDBOX, openLinks});
    await page.evaluate(({id, width, height}) => (window as any).hostProbe.resize(id, width, height), {id, width, height});
    const frame = (await (await page.locator(`#${id}`).elementHandle())!.contentFrame())!;
    await page.waitForFunction(id => (window as any).hostProbe.state(id).initialized, id);
    return {id, frame};
  }
  const deliver = (id: string, result: unknown) => page.evaluate(({id, result}) => (window as any).hostProbe.result(id, result), {id, result});
  const settle = (frame: Frame) => frame.evaluate(() => new Promise(r => { const t = setTimeout(r, 600); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(undefined); })); }));
  const text = async (frame: Frame, selector: string) => (await frame.locator(selector).innerText()).trim();
  // The numbers actually laid out in the floral disks: the text of each list item's ::before in Chromium's DOM snapshot
  // (computed style keeps counter() unresolved; the snapshot has the laid-out generated text, in document order).
  async function displayedNumbers(id: string): Promise<string[]> {
    const cdp = await context.newCDPSession(page);
    try {
      const snap: any = await cdp.send('DOMSnapshot.captureSnapshot', {computedStyles: []});
      const doc = snap.documents.find((d: any) => snap.strings[d.documentURL].endsWith('/' + id));
      assert.ok(doc, 'the view document is in the snapshot');
      const found: string[] = [];
      doc.layout.nodeIndex.forEach((node: number, i: number) => {
        const textIndex = doc.layout.text[i];
        if (textIndex >= 0 && snap.strings[doc.nodes.nodeName[node]] === '::before') found.push(snap.strings[textIndex]);
      });
      return found;
    } finally { await cdp.detach(); }
  }

  // Strict policy keeps the application credit inert, just like answer links.
  const strictBytes = bytes.replace(/(<script[^>]*id="saga-content-policy"[^>]*>)[\s\S]*?(<\/script>)/, '$1{"level":"strict"}$2');
  assert.notEqual(strictBytes, bytes, 'the Strict fixture replaces the embedded policy');
  const strict = await openView(760, 900, strictBytes);
  await deliver(strict.id, resultA);
  await strict.frame.locator('[data-testid="saga-credit"]').waitFor();
  const strictButtons = await strict.frame.locator('[data-testid="saga-credit"] button').count();
  const strictOpens = await page.evaluate(id => (window as any).hostProbe.state(id).openLinks, strict.id);
  check('links:strict-credit-is-text-only', () => {
    assert.equal(strictButtons, 0);
    assert.deepEqual(strictOpens, []);
  });

  // ---- Start failures are worded apart: policy, connection and fonts ---------------------------
  // A view that did not start says why, in the application's own sentence. The font failure is not a
  // connection failure: the host connected and the handshake completed before the fonts were refused.
  const START_FAILURES = {
    policy: 'This view could not start: its content policy is not valid.',
    connect: 'The answer card could not connect. Please retry the question.',
    fonts: 'The answer card could not load its fonts. Please retry the question.',
  };
  async function openStartFailure(html: string, connect: true | 'reject'): Promise<{id: string; frame: Frame; body: () => Promise<string>}> {
    const id = `view${++counter}`;
    served.set(`/${id}`, html);
    await page.evaluate(({id, url, sandbox, connect}) => (window as any).hostProbe.create(id, url, connect, sandbox, true), {id, url: `http://127.0.0.1:${ports[1]}/${id}`, sandbox: SANDBOX, connect});
    const frame = (await (await page.locator(`#${id}`).elementHandle())!.contentFrame())!;
    return {id, frame, body: async () => (await frame.evaluate(() => document.body.innerText)).trim()};
  }
  const seenBy = (id: string) => page.evaluate(id => (window as any).hostProbe.state(id), id);
  const kitabRegular = fs.readFileSync(new URL('../assets/fonts/Kitab-Regular.ttf', import.meta.url)).toString('base64');
  assert.ok(bytes.includes(kitabRegular), 'the Regular face is embedded verbatim');
  const brokenFonts = bytes.replace(kitabRegular, 'A'.repeat(kitabRegular.length));
  const invalidPolicy = bytes.replace(/(<script[^>]*id="saga-content-policy"[^>]*>)[\s\S]*?(<\/script>)/, '$1{not json$2');
  assert.notEqual(invalidPolicy, bytes, 'the invalid-policy fixture replaces the embedded policy');
  const policyFailed = await openStartFailure(invalidPolicy, true);
  await policyFailed.frame.getByText(START_FAILURES.policy).waitFor();
  const policyState = await seenBy(policyFailed.id);
  const policyCards = await policyFailed.frame.evaluate(() => document.querySelectorAll('.answer-card, .saga-card').length);
  check('start-failure:invalid-policy-shows-its-text-and-never-connects', () => {
    assert.equal(policyCards, 0);
    assert.ok(!policyState.seen.includes('ui/initialize'), 'no handshake was started on a guessed policy');
  });
  assert.equal(await policyFailed.body(), START_FAILURES.policy);
  const connectFailed = await openStartFailure(bytes, 'reject');
  await connectFailed.frame.getByText(START_FAILURES.connect).waitFor();
  const connectState = await seenBy(connectFailed.id);
  check('start-failure:host-rejecting-the-handshake-shows-the-connect-text', () => {
    assert.equal(connectState.rejected, 1);
    assert.equal(connectState.initialized, false);
  });
  assert.equal(await connectFailed.body(), START_FAILURES.connect);
  const fontsFailed = await openStartFailure(brokenFonts, true);
  await fontsFailed.frame.getByText(START_FAILURES.fonts).waitFor();
  const fontsState = await seenBy(fontsFailed.id);
  const fontsBody = await fontsFailed.body();
  check('start-failure:font-failure-shows-the-ready-text-and-is-not-a-connect-failure', () => {
    assert.ok(fontsState.seen.includes('ui/initialize'), 'the host handshake was reached');
    assert.equal(fontsBody, START_FAILURES.fonts);
    assert.notEqual(START_FAILURES.fonts, START_FAILURES.connect);
    assert.equal(new Set(Object.values(START_FAILURES)).size, 3, 'the three start failures read differently');
  });
  await deliver(fontsFailed.id, {content: [], structuredContent: {version: '0.1.0', question: 'q', answer: 'never shown'}}).catch(() => {});
  await settle(fontsFailed.frame);
  const fontsAfter = await fontsFailed.body();
  check('start-failure:no-answer-appears-on-a-view-whose-fonts-failed', () => assert.equal(fontsAfter, START_FAILURES.fonts));

  // ---- Neutral initial state ------------------------------------------------------------------
  const first = await openView();
  // The document the host mounted names the SDK artifacts it was built from, beside the application release.
  const sdkIdentity = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/sdk-identity.mjs', import.meta.url).pathname], {encoding: 'utf8'}));
  const mounted = await first.frame.evaluate(() => { const data = document.body.dataset; return {release: data.release, sdkKind: data.sdkKind, sdkVersion: data.sdkVersion, sdkSource: data.sdkSource, sdkStackSha256: data.sdkStackSha256, sdkSetSha256: data.sdkSetSha256, meta: document.querySelector('meta[name="ansari-sdk"]')?.getAttribute('content')}; });
  check('document:sdk-identity-beside-release', () => {
    assert.deepEqual({kind: mounted.sdkKind, version: mounted.sdkVersion, source: mounted.sdkSource, stackSha256: mounted.sdkStackSha256, setSha256: mounted.sdkSetSha256}, sdkIdentity);
    assert.equal(mounted.meta, sdkIdentity.version);
    assert.match(mounted.release ?? '', /^\d+\.\d+\.\d+/);
  });
  const initial = await first.frame.evaluate(() => ({
    status: document.querySelector('[data-testid="answer-status"]')?.textContent, cards: document.querySelectorAll('.answer-card, .saga-card').length,
    body: document.body.innerText.trim(),
  }));
  check('initial:neutral-waiting-no-card-no-canned-answer', () => {
    assert.equal(initial.status, WAITING_TEXT);
    assert.equal(initial.cards, 0);
    assert.equal(initial.body, WAITING_TEXT);
  });

  // ---- Answer A then answer B in ONE mounted view ----------------------------------------------
  await deliver(first.id, resultA);
  await first.frame.locator('[data-testid="answer-card"]').waitFor();
  await settle(first.frame);
  await first.frame.evaluate(() => { (document.querySelector('main') as any).__mounted = 'same'; (document.getElementById('root') as any).__mounted = 'same'; });
  const shownA = await first.frame.evaluate(() => ({
    question: document.querySelector('[data-testid="question"]')?.textContent,
    cardText: (document.querySelector('.saga-card-content') as HTMLElement).innerText,
    attribution: document.querySelector('.answer-card')!.hasAttribute('data-attribution'),
    status: document.querySelector('[data-testid="answer-status"]')?.textContent,
  }));
  check('answer-A:question-and-text-in-order', () => {
    assert.equal(shownA.question, QUESTION_A);
    assert.equal(shownA.status, '');
    const order = ['Synthetic heading A', 'Synthetic answer A. التقوى', 'Third', 'Fourth point', 'nested one', 'nested two', 'a bullet', 'a quoted line', 'This information came from ansari.chat'];
    let at = -1;
    for (const part of order) { const next = shownA.cardText.indexOf(part, at + 1); assert.ok(next > at, `${part} follows the previous part`); at = next; }
  });
  check('answer-A:attribution-footer-selected', () => assert.equal(shownA.attribution, true));
  for (const width of [375, 760]) {
    await page.evaluate(({id, width}) => (window as any).hostProbe.resize(id, width, 900), {id: first.id, width});
    await settle(first.frame);
    const footer = await first.frame.evaluate(() => {
      const content = document.querySelector('.saga-card-content')!;
      const paragraph = content.lastElementChild!;
      const credit = document.querySelector('.saga-credit')!;
      return {
        ruleCount: Array.from(content.querySelectorAll('hr')).filter(el => getComputedStyle(el).display !== 'none').length,
        border: getComputedStyle(paragraph).borderTopWidth,
        alignment: getComputedStyle(credit).textAlign,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    check(`footer:${width}:one-rule-and-right-aligned-signature`, () => {
      assert.equal(footer.ruleCount + (parseFloat(footer.border) > 0 ? 1 : 0), 1);
      assert.equal(footer.alignment, 'right');
      assert.equal(footer.overflow, false);
    });
  }
  const numbersA = await displayedNumbers(first.id);
  const listsA = await first.frame.evaluate(() => {
    const content = (el: Element, pseudo: string) => getComputedStyle(el, pseudo).content;
    const top = document.querySelector('.saga-card-content > ol')!;
    const items = Array.from(top.children) as HTMLElement[];
    const nested = Array.from(items[1]!.querySelectorAll(':scope > ol > li')) as HTMLElement[];
    const box = (el: Element) => { const s = getComputedStyle(el, '::before'); return {w: s.width, h: s.height, bg: s.backgroundImage.slice(0, 40)}; };
    return {
      start: top.getAttribute('start'), tag: top.tagName, itemCount: items.length, nestedCount: nested.length,
      topBox: box(items[0]!), nestedBox: box(nested[0]!), markerContent: getComputedStyle(items[0]!, '::marker').content,
      listStyle: getComputedStyle(top).listStyleType, display: getComputedStyle(items[0]!).display,
    };
  });
  evidence.listsA = listsA;
  check('numbering:native-ol-start-3-and-displayed-3-4', () => {
    assert.equal(listsA.tag, 'OL');
    assert.equal(listsA.start, '3');
    assert.equal(listsA.itemCount, 2);
    assert.deepEqual(numbersA, ['3', '4', '1', '2']);
    assert.equal(listsA.display, 'list-item');
    assert.notEqual(listsA.listStyle, 'none');
  });
  check('numbering:nested-list-restarts-at-1-with-smaller-disk', () => {
    assert.equal(listsA.nestedCount, 2);
    assert.equal(listsA.markerContent, '""', 'the native marker is replaced by the disk, the list keeps its semantics');
    assert.equal(listsA.topBox.w, '64px');
    assert.equal(listsA.nestedBox.w, '44px');
    assert.match(listsA.topBox.bg, /url\("data:image\/png;base64,/);
  });
  const aria = await first.frame.locator('.saga-card-content').ariaSnapshot();
  evidence.ariaA = aria;
  check('numbering:accessible-list-semantics', () => {
    assert.match(aria, /- list:/);
    assert.match(aria, /- listitem:/);
    // The disk is generated content with empty alternative text: the number is not announced twice.
    assert.ok(!/"?3"?\s*3/.test(aria));
  });

  await first.frame.locator('.saga-card-link').click();
  await page.waitForFunction(id => (window as any).hostProbe.state(id).openLinks.length === 1, first.id);
  await settle(first.frame);
  const attributionNoticeVisible = await first.frame.locator('.saga-card-link-status').isVisible();
  check('links:successful-attribution-is-silent', () => assert.equal(attributionNoticeVisible, false));
  const opened = await page.evaluate(id => (window as any).hostProbe.state(id).openLinks, first.id);
  check('links:attribution-link-reaches-host-only-through-openLink', () => assert.deepEqual(opened, ['https://ansari.chat/']));

  await first.frame.getByRole('button', {name: 'saga a2ui', exact: true}).click();
  await page.waitForFunction(id => (window as any).hostProbe.state(id).openLinks.length === 2, first.id);
  await settle(first.frame);
  const creditNotice = await first.frame.locator('[data-testid="saga-credit"] [role="status"]').textContent();
  check('links:successful-credit-is-silent', () => assert.equal(creditNotice, ''));
  const creditOpened = await page.evaluate(id => (window as any).hostProbe.state(id).openLinks, first.id);
  check('links:saga-credit-follows-unchanged-answer-and-uses-host', () => {
    assert.deepEqual(creditOpened, ['https://ansari.chat/', 'https://github.com/MachineWisdomAI/saga-a2ui']);
    assert.ok(!shownA.cardText.includes('Built with'));
  });

  // Both attribution and signature use visibly separate notices when the host cannot open links.
  const unavailable = await openView(375, 900, bytes, false);
  await deliver(unavailable.id, resultA);
  for (const [button, status, destination] of [
    ['.saga-card-link', '.saga-card-link-status', 'https://ansari.chat/'],
    ['.saga-credit button', '.saga-credit [role="status"]', 'https://github.com/MachineWisdomAI/saga-a2ui'],
  ] as const) {
    await unavailable.frame.locator(button).click();
    await unavailable.frame.locator(status).filter({hasText: 'This host cannot open links.'}).waitFor();
    const notice = await unavailable.frame.locator(status).evaluate(el => ({
      text: el.textContent, border: getComputedStyle(el).borderInlineStartWidth,
      label: getComputedStyle(el, '::before').content,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    check(`links:unavailable-notice:${destination}`, () => {
      assert.equal(notice.text, `This host cannot open links. Destination: ${destination}`);
      assert.ok(parseFloat(notice.border) > 0);
      assert.equal(notice.label, '"Link notice"');
      assert.equal(notice.overflow, false);
    });
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(({id, theme}) => (window as any).hostProbe.theme(id, theme), {id: unavailable.id, theme});
    await unavailable.frame.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
    const ratios = await unavailable.frame.locator('[role="status"]').evaluateAll(elements => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      return elements.filter(el => el.textContent).map(el => {
        const style = getComputedStyle(el);
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    });
    check(`links:${theme}:readable-notices`, () => {
      assert.equal(ratios.length, 2);
      for (const ratio of ratios) assert.ok(ratio >= 4.5, `contrast ${ratio}`);
    });
    await page.locator(`#${unavailable.id}`).screenshot({path: `${out}/footer-link-notices-${theme}.png`});
  }

  await deliver(first.id, resultB);
  await first.frame.getByText('الصبر مفتاح الفرج', {exact: false}).waitFor();
  await settle(first.frame);
  const numbersB = await displayedNumbers(first.id);
  const shownB = await first.frame.evaluate(() => ({
    same: (document.querySelector('main') as any).__mounted === 'same' && (document.getElementById('root') as any).__mounted === 'same',
    question: document.querySelector('[data-testid="question"]')?.textContent,
    cardText: (document.querySelector('.saga-card-content') as HTMLElement).innerText,
    questionDir: getComputedStyle(document.querySelector('[data-testid="question"]')!).direction,
    paragraphDir: getComputedStyle(document.querySelector('.saga-card-content > p')!).direction,
    itemDir: getComputedStyle(document.querySelector('.saga-card-content ol > li')!).direction,
    itemPad: {left: getComputedStyle(document.querySelector('.saga-card-content ol > li')!).paddingLeft, right: getComputedStyle(document.querySelector('.saga-card-content ol > li')!).paddingRight},
    attribution: document.querySelector('.answer-card')!.hasAttribute('data-attribution'),
    footerDir: getComputedStyle(document.querySelector('.saga-card-content > p:last-child')!).direction,
    footerBorder: getComputedStyle(document.querySelector('.saga-card-content > p:last-child')!).borderTopWidth,
  }));
  check('two-answers:one-mounted-view-answer-B-replaces-A', () => {
    assert.equal(shownB.same, true);
    assert.equal(shownB.question, QUESTION_B);
    assert.ok(!shownB.cardText.includes('Synthetic answer A'));
    assert.ok(shownB.cardText.startsWith('الصبر'));
    assert.deepEqual(numbersB, ['1', '2']);
  });
  check('rtl:question-paragraph-and-item-directions', () => {
    assert.equal(shownB.questionDir, 'rtl');
    assert.equal(shownB.paragraphDir, 'rtl');
    assert.equal(shownB.itemDir, 'rtl');
    assert.ok(parseFloat(shownB.itemPad.right) > parseFloat(shownB.itemPad.left), 'the disk sits on the inline start (right) side');
    assert.equal(shownB.attribution, true);
    assert.equal(shownB.footerDir, 'ltr');
    assert.equal(shownB.footerBorder, '1px', 'an answer without a supplied rule keeps the footer border');
  });

  // ---- Answer without attribution gets no footer treatment ---------------------------------------
  await deliver(first.id, resultC);
  await first.frame.getByText('Synthetic answer C.', {exact: false}).waitFor();
  const shownC = await first.frame.evaluate(() => {
    const last = document.querySelector('.saga-card-content > p:last-child') as HTMLElement;
    return {attribution: document.querySelector('.answer-card')!.hasAttribute('data-attribution'), border: getComputedStyle(last).borderTopWidth, size: getComputedStyle(last).fontSize, text: last.textContent};
  });
  check('attribution:ordinary-closing-paragraph-keeps-normal-style', () => {
    assert.equal(shownC.attribution, false);
    assert.equal(shownC.border, '0px');
    assert.equal(shownC.size, '18px');
    assert.equal(shownC.text, 'A closing paragraph that is not the attribution.');
  });

  // ---- Lookalike closings: the footer follows the closing paragraph the card rendered --------------
  for (const lookalike of ATTRIBUTION_CASES) {
    await deliver(first.id, await callTool(lookalike.question));
    await first.frame.getByText(lookalike.probe, {exact: false}).waitFor();
    await settle(first.frame);
    const footer = await first.frame.evaluate(() => document.querySelector('.answer-card')!.hasAttribute('data-attribution'));
    check(`attribution:${lookalike.question.toLowerCase().replaceAll(' ', '-')}-footer-is-${lookalike.footer}`, () => assert.equal(footer, lookalike.footer));
  }

  // ---- Failure clears the answer; the next valid result recovers --------------------------------
  await deliver(first.id, failure);
  await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
  const afterFailure = await first.frame.evaluate(() => ({body: document.body.innerText.trim(), cards: document.querySelectorAll('.answer-card, .saga-card').length}));
  check('failure:server-error-clears-answer-and-shows-only-the-safe-message', () => {
    assert.equal(afterFailure.cards, 0);
    assert.equal(afterFailure.body, 'Ansari could not complete this request.');
  });
  await deliver(first.id, {content: [{type: 'text', text: 'ignored'}], structuredContent: {version: '9.9.9', question: 'q', answer: 'wrong version'}});
  await first.frame.getByText(UNSUPPORTED_TEXT).waitFor();
  const afterUnsupported = await first.frame.evaluate(() => ({body: document.body.innerText.trim(), cards: document.querySelectorAll('.answer-card, .saga-card').length}));
  check('failure:unsupported-version-shows-unsupported-text-and-no-card', () => {
    assert.equal(afterUnsupported.cards, 0);
    assert.equal(afterUnsupported.body, UNSUPPORTED_TEXT);
  });
  // A result that carries a structured envelope is read from it alone: text beside a malformed envelope never rescues it.
  for (const [name, malformed] of [
    ['array', {content: [{type: 'text', text: 'Fallback text.\n'}], structuredContent: ['x']}],
    ['not-an-object', {content: [{type: 'text', text: 'Fallback text.\n'}], structuredContent: 'x'}],
    ['question-missing', {content: [{type: 'text', text: 'Fallback text.\n'}], structuredContent: {version: '0.1.0', answer: 'a'}}],
    ['empty-answer', {content: [{type: 'text', text: 'Fallback text.\n'}], structuredContent: {version: '0.1.0', question: 'q', answer: ''}}],
  ] as const) {
    await deliver(first.id, resultA);
    await first.frame.locator('[data-testid="answer-card"]').waitFor();
    await deliver(first.id, malformed);
    await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
    const shownMalformed = await first.frame.evaluate(() => ({body: document.body.innerText.trim(), cards: document.querySelectorAll('.answer-card, .saga-card').length}));
    check(`failure:malformed-structured-${name}-is-unsupported-even-with-text`, () => {
      assert.equal(shownMalformed.cards, 0);
      assert.equal(shownMalformed.body, UNSUPPORTED_TEXT);
    });
  }
  // A failed call shows its own first usable text, whatever the structured content says; with none, the unsupported sentence.
  for (const [name, failed, expected] of [
    ['server-text', {isError: true, content: [{type: 'text', text: 'Server wrote this.'}]}, 'Server wrote this.'],
    ['valid-structured-does-not-save-it', {isError: true, content: [{type: 'text', text: 'Server wrote this.'}], structuredContent: {version: '0.1.0', question: 'q', answer: 'never shown'}}, 'Server wrote this.'],
    ['no-text', {isError: true, content: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]}, UNSUPPORTED_TEXT],
    ['empty-first-text-is-not-skipped', {isError: true, content: [{type: 'text', text: ''}, {type: 'text', text: 'Later text.'}]}, UNSUPPORTED_TEXT],
  ] as const) {
    await deliver(first.id, resultA);
    await first.frame.locator('[data-testid="answer-card"]').waitFor();
    await deliver(first.id, failed);
    await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
    const shownFailed = await first.frame.evaluate(() => ({body: document.body.innerText.trim(), cards: document.querySelectorAll('.answer-card, .saga-card').length}));
    check(`failure:error-result-${name}`, () => {
      assert.equal(shownFailed.cards, 0);
      assert.equal(shownFailed.body, expected);
    });
  }
  // A host that delivers only the text result still shows the answer, exactly as sent and without a heading.
  const TEXT_ONLY = 'Text only answer.\n\nSecond paragraph.\n';
  await deliver(first.id, resultA);
  await first.frame.locator('[data-testid="answer-card"]').waitFor();
  for (const [name, delivered] of [
    ['absent', {content: [{type: 'text', text: TEXT_ONLY}]}],
    ['null', {content: [{type: 'text', text: TEXT_ONLY}], structuredContent: null}],
  ] as const) {
    await deliver(first.id, failure);
    await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
    await deliver(first.id, delivered);
    await first.frame.getByText('Second paragraph.').waitFor();
    const shownText = await first.frame.evaluate(() => ({cards: document.querySelectorAll('.answer-card').length, questions: document.querySelectorAll('[data-testid="question"]').length, status: document.querySelector('[data-testid="answer-status"]')?.textContent}));
    check(`fallback:text-only-${name}-structured-shows-the-text-answer-without-a-heading`, () => {
      assert.equal(shownText.cards, 1);
      assert.equal(shownText.questions, 0);
      assert.equal(shownText.status, '');
    });
  }
  // A later empty first text block does not let a second block stand in.
  await deliver(first.id, {content: [{type: 'text', text: ''}, {type: 'text', text: 'Later text.'}]});
  await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
  await first.frame.getByText(UNSUPPORTED_TEXT).waitFor();
  const emptyFirst = await first.frame.evaluate(() => ({body: document.body.innerText.trim(), cards: document.querySelectorAll('.answer-card, .saga-card').length}));
  check('fallback:empty-first-text-block-is-unsupported-not-skipped', () => {
    assert.equal(emptyFirst.cards, 0);
    assert.equal(emptyFirst.body, UNSUPPORTED_TEXT);
  });
  await deliver(first.id, resultA);
  await first.frame.locator('[data-testid="answer-card"]').waitFor();
  await deliver(first.id, {isError: true, content: [{type: 'text', text: 'Ansari could not complete this request.'}]});
  await first.frame.locator('[data-testid="answer-card"]').waitFor({state: 'detached'});
  await deliver(first.id, resultB);
  await first.frame.locator('[data-testid="answer-card"]').waitFor();
  const recoveredText = await text(first.frame, '.saga-card-content');

  // ---- Complete reload input in a fresh view renders the same answer ----------------------------
  const reload = await openView();
  await deliver(reload.id, resultB);
  await reload.frame.locator('[data-testid="answer-card"]').waitFor();
  const reloaded = {card: await text(reload.frame, '.saga-card-content'), question: await text(reload.frame, '[data-testid="question"]')};
  check('reload:complete-result-in-a-fresh-view-renders-the-same-answer', () => {
    assert.equal(reloaded.card, recoveredText);
    assert.equal(reloaded.question, QUESTION_B);
  });

  // ---- Artwork: theme-specific, embedded, decodable, selected only by the app --------------------
  async function artwork(frame: Frame) {
    return frame.evaluate(async () => {
      const root = document.documentElement;
      const names = ['flourish', 'marker', 'separator'];
      const resolved: Record<string, string> = {};
      for (const name of names) resolved[name] = getComputedStyle(root).getPropertyValue(`--ansari-art-${name}`).trim();
      const decoded: Record<string, number> = {};
      for (const name of names) {
        const match = /url\("(data:image\/png;base64,[^"]+)"\)/.exec(resolved[name]!);
        if (!match) { decoded[name] = -1; continue; }
        const image = new Image();
        image.src = match[1]!;
        await image.decode();
        decoded[name] = image.naturalWidth;
      }
      const header = getComputedStyle(document.querySelector('.answer-header')!, '::after');
      const markerItem = document.querySelector('.saga-card-content ol > li');
      const marker = markerItem === null ? undefined : getComputedStyle(markerItem, '::before');
      return {resolved, decoded, headerBg: header.backgroundImage, markerBg: marker?.backgroundImage ?? '', imgs: document.images.length, theme: root.getAttribute('data-theme')};
    });
  }
  await page.evaluate(id => (window as any).hostProbe.theme(id, 'light'), first.id);
  await first.frame.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  const light = await artwork(first.frame);
  await page.evaluate(id => (window as any).hostProbe.theme(id, 'dark'), first.id);
  await first.frame.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  const dark = await artwork(first.frame);
  check('artwork:separate-light-and-dark-embedded-decodable-images', () => {
    for (const set of [light, dark]) {
      for (const name of ['flourish', 'marker', 'separator']) assert.ok(set.decoded[name]! > 0, `${name} decodes`);
      assert.equal(set.imgs, 0, 'artwork is CSS, not an image element');
    }
    for (const name of ['flourish', 'marker', 'separator']) assert.notEqual(light.resolved[name], dark.resolved[name]);
    assert.equal(light.headerBg.includes(light.resolved.flourish!.slice(5, 60)), true);
    assert.equal(dark.headerBg.includes(dark.resolved.flourish!.slice(5, 60)), true);
    assert.equal(dark.markerBg.includes(dark.resolved.marker!.slice(5, 60)), true);
    assert.notEqual(light.markerBg, dark.markerBg);
  });

  // ---- Typography: reading profile maps to effective card typography, no root scaling -----------
  const metrics = (frame: Frame) => frame.evaluate(() => {
    const card = document.querySelector('.saga-card') as HTMLElement;
    const wrapper = document.querySelector('.answer-card') as HTMLElement;
    const html = document.documentElement;
    const p = document.querySelector('.saga-card-content p') as HTMLElement;
    const question = document.querySelector('[data-testid="question"]') as HTMLElement;
    const cs = getComputedStyle(card);
    return {
      profile: html.getAttribute('data-reading-profile'), rootTransform: getComputedStyle(html).transform, bodyTransform: getComputedStyle(document.body).transform, rootScale: html.getAttribute('data-root-scale'),
      cardFont: cs.fontSize, cardLine: cs.lineHeight, cardFamily: cs.fontFamily, cardMax: cs.maxWidth, paragraph: getComputedStyle(p).fontSize, question: getComputedStyle(question).fontSize,
      wrapperMax: getComputedStyle(wrapper).maxWidth, wrapperWidth: wrapper.getBoundingClientRect().width, viewport: window.innerWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  await page.evaluate(id => (window as any).hostProbe.theme(id, 'light'), first.id);
  await first.frame.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  const desktop = await metrics(first.frame);
  check('typography:desktop-profile-effective-card-typography', () => {
    assert.equal(desktop.profile, 'desktop');
    assert.equal(desktop.cardFont, '18px');
    assert.equal(desktop.paragraph, '18px');
    assert.equal(desktop.question, '26px');
    assert.equal(desktop.cardLine, '26.64px');
    assert.equal(desktop.rootTransform, 'none');
    assert.equal(desktop.rootScale, '1');
    assert.equal(desktop.cardFamily, 'Kitab');
  });
  const fonts = await first.frame.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.fonts).map(face => ({family: face.family, weight: face.weight, status: face.status}));
  });
  check('typography:both-embedded-Kitab-weights-loaded', () => {
    assert.deepEqual(fonts.map(f => ({...f, family: f.family.replaceAll('"', '').replaceAll("'", '')})).sort((a,b) => a.weight.localeCompare(b.weight)), [
      {family:'Kitab',weight:'400',status:'loaded'}, {family:'Kitab',weight:'700',status:'loaded'},
    ]);
  });
  // A device profile (Echo Show class) on a wide view: the adapter publishes the scale; the card's own typography follows it.
  const trace = (s: string) => { if (process.env.REACT_BROWSER_TRACE) console.error('..', s); };
  trace('open wide');
  const wide = await openView(1000, 900);
  trace('deliver');
  await deliver(wide.id, resultA);
  trace('delivered');
  await wide.frame.locator('[data-testid="answer-card"]').waitFor();
  trace('context');
  await page.evaluate(id => (window as any).hostProbe.hostContext(id, {theme: 'light', deviceClass: 'echo_show_15'}), wide.id);
  trace('context sent');
  await wide.frame.waitForFunction(() => document.documentElement.getAttribute('data-reading-profile') === 'device');
  await settle(wide.frame);
  const device = await metrics(wide.frame);
  check('typography:device-profile-scales-card-typography-and-width-without-root-transform', () => {
    assert.equal(device.profile, 'device');
    assert.equal(device.cardFont, '28.8px');
    assert.equal(device.paragraph, '28.8px');
    assert.equal(device.question, '41.6px');
    assert.equal(device.wrapperMax, '1088px');
    assert.equal(device.rootTransform, 'none');
    assert.equal(device.bodyTransform, 'none');
    assert.equal(device.rootScale, '1');
    assert.equal(device.overflow, false);
  });
  const listsDevice = await wide.frame.evaluate(() => { const li = document.querySelector('.saga-card-content > ol > li')!; return getComputedStyle(li, '::before').width; });
  check('typography:device-profile-scales-the-floral-disk', () => assert.ok(Math.abs(parseFloat(listsDevice) - 102.4) < 0.05, listsDevice));

  // The stack decides the profile (`readingProfile`); the adapter only maps it. A mobile platform reads as a device;
  // a desktop platform on the same wide view does not, and publishes scale 1.
  const profileOf = (frame: Frame) => frame.evaluate(() => ({profile: document.documentElement.getAttribute('data-reading-profile'), scale: document.documentElement.style.getPropertyValue('--ansari-wide-reading-scale')}));
  const mobile = await openView(1000, 900);
  await deliver(mobile.id, resultA);
  await mobile.frame.locator('[data-testid="answer-card"]').waitFor();
  await page.evaluate(id => (window as any).hostProbe.hostContext(id, {theme: 'light', platform: 'mobile'}), mobile.id);
  await mobile.frame.waitForFunction(() => document.documentElement.getAttribute('data-reading-profile') === 'device');
  const desktopView = await openView(1000, 900);
  await deliver(desktopView.id, resultA);
  await desktopView.frame.locator('[data-testid="answer-card"]').waitFor();
  await page.evaluate(id => (window as any).hostProbe.hostContext(id, {theme: 'light', platform: 'desktop'}), desktopView.id);
  await desktopView.frame.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  const [mobileProfile, desktopProfile, deviceProfile] = [await profileOf(mobile.frame), await profileOf(desktopView.frame), await profileOf(wide.frame)];
  check('typography:reading-profile-comes-from-the-stack-for-device-class-mobile-and-desktop', () => {
    assert.deepEqual(deviceProfile, {profile: 'device', scale: '1.6'});
    assert.deepEqual(mobileProfile, {profile: 'device', scale: '1.6'});
    assert.deepEqual(desktopProfile, {profile: 'desktop', scale: '1'});
  });

  // ---- Reference widths: 680px and 375px, both themes -------------------------------------------
  const shots: Record<string, unknown> = {};
  for (const [width, label] of [[680, 'wide'], [375, 'narrow']] as const) {
    const view = await openView(width, 1500);
    await deliver(view.id, resultA);
    await view.frame.locator('[data-testid="answer-card"]').waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(({id, theme}) => (window as any).hostProbe.theme(id, theme), {id: view.id, theme});
      await view.frame.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
      await settle(view.frame);
      const m = await metrics(view.frame);
      const geometry = await view.frame.evaluate(() => {
        const rect = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
        const cs = (el: Element, pseudo: string) => getComputedStyle(el, pseudo);
        const header = document.querySelector('.answer-header')!;
        const flourish = cs(header, '::after');
        const li = document.querySelector('.saga-card-content > ol > li')!;
        const footer = document.querySelector('.saga-card-content > p:last-child')!;
        return {
          card: rect(document.querySelector('.answer-card')), header: rect(header), flourishW: flourish.width, markerW: cs(li, '::before').width, markerFont: cs(li, '::before').fontSize,
          footerFont: getComputedStyle(footer).fontSize, footerBorder: getComputedStyle(footer).borderTopWidth, surface: getComputedStyle(document.querySelector('.answer-card')!).backgroundColor,
          ink: getComputedStyle(document.querySelector('.saga-card-content p')!).color, separatorH: cs(li, '::after').height,
        };
      });
      shots[`${label}-${theme}`] = {width, metrics: m, geometry};
      await page.locator(`#${view.id}`).screenshot({path: `${out}/${label}-${theme}-${width}.png`});
      if (width === 375) check(`reference-${label}-${theme}:no-horizontal-overflow`, () => assert.equal(m.overflow, false));
      check(`reference-${label}-${theme}:approved-metrics`, () => {
        const g: any = geometry;
        if (width === 680) {
          assert.equal(m.cardFont, '18px');
          assert.equal(g.flourishW, '94px');
          assert.equal(g.markerW, '64px');
          assert.equal(g.markerFont, '25px');
          assert.equal(g.footerFont, '14px');
          assert.equal(g.footerBorder, '0px');
          assert.equal(g.card.w <= 680, true);
        } else {
          assert.equal(m.cardFont, '16px');
          assert.equal(g.flourishW, '60px');
          assert.equal(g.markerW, '44px');
          assert.equal(g.markerFont, '20px');
          assert.equal(g.footerFont, '14px');
          assert.equal(m.question, '22px');
        }
        assert.equal(g.separatorH, '24px');
        assert.equal(g.surface, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(20, 25, 28)');
        assert.equal(g.ink, theme === 'light' ? 'rgb(23, 34, 53)' : 'rgb(238, 241, 244)');
      });
    }
  }
  evidence.referenceWidths = shots;
  evidence.desktop = desktop;
  evidence.device = device;

  // ---- Hostile Markdown: inert, no request, artwork unchanged ----------------------------------
  const guarded = await openView();
  await deliver(guarded.id, resultA);
  await guarded.frame.locator('[data-testid="answer-card"]').waitFor();
  await guarded.frame.locator('.saga-card-content ol > li').first().waitFor();
  const artBefore = await artwork(guarded.frame);
  const requestsBefore = requests.length;
  await deliver(guarded.id, resultHostile);
  await guarded.frame.getByText('Answer text containing', {exact: false}).waitFor();
  await settle(guarded.frame);
  await guarded.frame.waitForTimeout(300);
  const hostile = await guarded.frame.evaluate(() => ({
    images: document.images.length, pwned: (window as any).__pwned ?? null, styleCount: document.querySelectorAll('style').length,
    buttons: Array.from(document.querySelectorAll('.saga-card-link')).map(b => b.textContent),
    anchors: document.querySelectorAll('a[href]').length, scripts: document.querySelectorAll('.saga-card script, .saga-card style').length,
    cardVisible: getComputedStyle(document.querySelector('.answer-card')!).display !== 'none',
    cardText: (document.querySelector('.saga-card-content') as HTMLElement).innerText,
    fontFaces: document.fonts.size,
  }));
  const artAfter = await artwork(guarded.frame);
  check('hostile:no-image-element-no-script-no-style-no-anchor-and-card-stays', () => {
    assert.equal(hostile.images, 0);
    assert.equal(hostile.pwned, null);
    assert.equal(hostile.anchors, 0);
    assert.equal(hostile.scripts, 0);
    assert.equal(hostile.cardVisible, true);
    assert.equal(hostile.buttons.length, 1, 'only the https link is a control');
    assert.match(hostile.buttons[0]!, /safe link/);
  });
  check('hostile:artwork-and-document-styles-unchanged-by-answer-text', () => {
    assert.deepEqual(artAfter.resolved, artBefore.resolved);
    assert.equal(artAfter.headerBg, artBefore.headerBg);
    assert.ok(!artAfter.resolved.flourish!.includes('evil.example'));
  });
  check('hostile:no-request-beyond-fixture-origins', () => {
    const bad = requests.filter(r => /evil\.example/.test(r.url));
    assert.deepEqual(bad, []);
    assert.equal(requests.slice(requestsBefore).filter(r => r.from === 'view').length, 0);
  });

  // ---- No runtime network from the view at all ---------------------------------------------------
  check('network:view-made-no-request-except-its-own-document', () => {
    const fromView = requests.filter(r => r.from === 'view' && !r.url.startsWith(`http://127.0.0.1:${ports[1]}/view`));
    assert.deepEqual(fromView, []);
  });

  // ---- An equal answer is a new selection: image consent does not carry over --------------------
  // Strict policy with one permitted image host. The document carries exactly the restrictions that
  // policy derives, so the image controls are live; the fixture host answers with a 1x1 image.
  const imagePolicy = createContentPolicy({level: 'strict', imageHosts: ['images.example']});
  assert.ok(imagePolicy.ok);
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const imageRequests: string[] = [];
  await context.route('https://images.example/**', (route: any) => { imageRequests.push(route.request().url()); route.fulfill({status: 200, contentType: 'image/png', body: PIXEL}); });
  const imageBytes = bytes
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/, (_m, a, b) => `${a}${imagePolicy.policy.resource.contentSecurityPolicy}${b}`)
    .replace(/(<script[^>]*id="saga-content-policy"[^>]*>)[\s\S]*?(<\/script>)/, (_m, a, b) => `${a}${JSON.stringify(imagePolicy.policy.configuration).replaceAll('<', '\\u003c')}${b}`);
  assert.notEqual(imageBytes, bytes, 'the image-policy fixture replaces the embedded policy and its restrictions');
  const consent = await openView(760, 900, imageBytes);
  const imageAnswer = {content: [{type: 'text', text: 'ignored'}], structuredContent: {version: '0.1.0', question: 'Q image', answer: 'Image answer.\n\n![synthetic](https://images.example/a.png)\n\nThis information came from ansari.chat.'}};
  await deliver(consent.id, imageAnswer);
  const toggle = consent.frame.locator('.saga-card-controls button').filter({hasText: /images$/});
  await toggle.filter({hasText: 'Show images'}).waitFor();
  const imagesBefore = await consent.frame.evaluate(() => document.images.length);
  await toggle.click();
  await toggle.filter({hasText: 'Hide images'}).waitFor();
  const granted = await consent.frame.evaluate(() => ({images: document.images.length, status: document.querySelector('.saga-card-controls [role="status"]')?.textContent}));
  // The same answer again, byte for byte: still a new selection, so the earlier grant ends.
  await deliver(consent.id, imageAnswer);
  await toggle.filter({hasText: 'Show images'}).waitFor();
  await settle(consent.frame);
  const reset = await consent.frame.evaluate(() => ({images: document.images.length, status: document.querySelector('.saga-card-controls [role="status"]')?.textContent}));
  check('consent:image-grant-ends-when-an-equal-answer-is-presented-again', () => {
    assert.equal(imagesBefore, 0, 'nothing loads before the reader consents');
    assert.equal(granted.images, 1);
    assert.equal(granted.status, 'Images shown.');
    assert.equal(reset.images, 0);
    assert.equal(reset.status, '');
    assert.ok(imageRequests.length >= 1 && imageRequests.every(url => url === 'https://images.example/a.png'));
  });

  // ---- Teardown disposes the view; a late result reaches nothing -------------------------------
  const heldLink = await first.frame.locator('.saga-card-link').elementHandle();
  const opensBefore = await page.evaluate(id => (window as any).hostProbe.state(id).openLinks.length, first.id);
  const ack = await page.evaluate(id => (window as any).hostProbe.teardown(id), first.id);
  check('teardown:host-request-acknowledged', () => assert.deepEqual(ack, {}));
  await first.frame.locator('#root >> *').first().waitFor({state: 'detached'}).catch(() => {});
  const afterTeardown = await first.frame.evaluate(() => document.getElementById('root')!.childElementCount);
  check('teardown:react-tree-unmounted', () => assert.equal(afterTeardown, 0));
  const retiredFonts = await first.frame.evaluate(() => document.fonts.size);
  check('teardown:owned-fonts-removed', () => assert.equal(retiredFonts, 0));
  await heldLink!.evaluate((el: HTMLElement) => el.click()).catch(() => {});
  await deliver(first.id, resultA).catch(() => {});
  await settle(first.frame);
  const late = await first.frame.evaluate(() => ({children: document.getElementById('root')!.childElementCount, cards: document.querySelectorAll('.answer-card').length}));
  const opensAfter = await page.evaluate(id => (window as any).hostProbe.state(id).openLinks.length, first.id);
  check('teardown:late-result-and-held-link-do-nothing', () => {
    assert.equal(late.children, 0);
    assert.equal(late.cards, 0);
    assert.equal(opensAfter, opensBefore);
  });

  const states = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => (window as any).hostProbe.state(f.id)));
  check('host:no-view-initiated-tool-calls-and-no-host-errors', () => {
    for (const s of states) { assert.equal(s.answerCalls, 0); assert.deepEqual(s.hostErrors, []); }
  });
  check('browser:no-page-or-console-errors', () => assert.deepEqual(errors, []));

  await page.evaluate(() => (window as any).hostProbe.close()).catch(() => {});
  await client.close();
}

const bounded = (work: Promise<unknown> | undefined, ms = 4000) => Promise.race([work ?? Promise.resolve(), new Promise(resolve => setTimeout(resolve, ms))]).catch(() => {});
let failure: unknown;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await bounded(mcpClient?.close());
  await bounded(browser?.close());
  if (service) { service.server.closeAllConnections?.(); await bounded(service.close?.()); }
  if (host) await bounded(new Promise<void>(r => (host.httpServer.closeAllConnections(), host.httpServer.close(() => r()))));
  if (child) await bounded(new Promise<void>(r => (child.closeAllConnections(), child.close(() => r()))));
  fs.writeFileSync(`${out}/react-results.json`, JSON.stringify({checks, errors, ports, evidence, failed: failure === undefined ? undefined : String(failure), scope: 'built from packed SAGA packages; real MCP server and connection; sandboxed iframe in a local AppBridge fixture; local Chromium; not actual-host evidence'}, null, 2) + '\n');
}
if (failure !== undefined) process.exit(1);
for (const port of ports) {
  let refused = false;
  try { await fetch(`http://127.0.0.1:${port}`, {signal: AbortSignal.timeout(1000)}); } catch { refused = true; }
  assert.ok(refused, `closed port ${port}`);
}
console.log(JSON.stringify({checks: checks.length, errors, closedPorts: ports}));
