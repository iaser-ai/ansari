import { World, setWorldConstructor, type IWorldOptions } from '@cucumber/cucumber';
import type { Account, AnswerRecord, ChatResult, RawSendResult } from './api.ts';
import type { Profile } from './servers.ts';

export interface MeasuredRun {
  threadId: string;
  images: number;
  result: ChatResult;
  record: AnswerRecord | null;
}

export class ImageWorld extends World {
  /** Name of the running feature, for the report. */
  feature = '';
  profile: Profile | null = null;
  baseUrl = '';
  account: Account | null = null;
  threadId = '';

  /** Numbers drawn on the images of the last question. */
  numbers: string[] = [];
  last: ChatResult | null = null;
  lastStatus: number | null = null;
  raw: RawSendResult | null = null;

  /** Results of a batch of questions (abuse scenarios). */
  batch: ChatResult[] = [];
  /** Repeated measured runs (cost and latency scenarios). */
  runs: MeasuredRun[] = [];
  /** Per-image recall from the downsampling scenario. */
  recalls: { words: number; marked: number }[] = [];

  constructor(options: IWorldOptions) {
    super(options);
  }

  get token(): string {
    if (!this.account) throw new Error('No account: add "Given I am signed in as a registered user"');
    return this.account.token;
  }
}

setWorldConstructor(ImageWorld);
