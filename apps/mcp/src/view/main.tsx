import '@saga-a2ui/react-mcp-stack/faithful-card.css';
import './theme.css';
import {FaithfulCardApp, StartFailure, readingProfile, startFaithfulCardApp} from '@saga-a2ui/react-mcp-stack/faithful-card';
import {APP_VERSION} from '../version.js';
import {AnswerView} from './answer-view.js';
import {BRANDING} from './branding.js';
import {mark, noteCallbackError, noteHost, observedChrome, watchStart} from './diagnostics.js';
import {CARD_MAX_UTF16_UNITS} from './envelope.js';
import {installFloralArtwork} from './floral-artwork.js';
import {loadKitab} from './fonts.js';
import {applyHostTheme} from './host-theme.js';
import {classifyCardResult} from './tool-result.js';

// Application composition. The stack owns the handshake, the held and latest result, the content
// policy read from this document, host links, image consent, own sizing and teardown; Ansari owns
// what is its own: how it reads a whole delivered result (tool-result.ts), the sentences it shows,
// its chrome, fonts, artwork and host-theme mapping. The definition's one `.result(...)` reader
// receives the whole delivery-neutral result (a failed call, text-only delivery and a malformed
// envelope included), so nothing is intercepted before it.

mark('main');

const definition = FaithfulCardApp.define({name: BRANDING.name, version: APP_VERSION})
  .reader({dialect: 'commonmark-tables-strikethrough', maxLength: CARD_MAX_UTF16_UNITS})
  .policy('document')
  .result(classifyCardResult)
  .texts({
    waiting: BRANDING.waitingText,
    problem: BRANDING.problemText,
    connectFailure: BRANDING.connectFailureText,
    readyFailure: BRANDING.readyFailureText,
    policyFailure: BRANDING.policyFailureText,
  })
  .build();

const root = document.documentElement;
installFloralArtwork(root);

const container = document.getElementById('root');
if (container === null) throw new Error('The page has no #root element.');

// Each hook also marks how far the card got (diagnostics.ts, #335); none of them changes what is shown.
const running = startFaithfulCardApp(definition, {
  container,
  sizing: 'own',
  // Do not present an answer using a substituted device font if the embedded fonts fail.
  readyWhen: signal => loadKitab(document, signal).then(() => mark('fonts')),
  hostContext: (context, hostName) => {
    mark('context');
    noteHost(hostName);
    applyHostTheme(root, context, hostName, readingProfile(context, hostName));
  },
  chrome: observedChrome(AnswerView),
  onError: (error, phase) => { noteCallbackError(error, phase); console.error(error); },
});
watchStart(running.ready, failure => failure instanceof StartFailure ? failure.kind : 'application');
