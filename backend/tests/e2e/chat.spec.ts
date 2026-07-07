import { test, expect } from '@playwright/test';

test.describe('Chat Flow', () => {
  const timestamp = Date.now();
  const email = `chattest${timestamp}@example.com`;
  const password = 'TestPassword123!';

  test.beforeAll(async ({ request }) => {
    // Register a user via API first
    const response = await request.post('http://localhost:3000/api/v2/users/register', {
      data: {
        email,
        password,
        first_name: 'Chat',
        last_name: 'Test',
      },
    });
    expect(response.status()).toBe(200);
    console.log('Test user registered:', email);
  });

  test('can ask a question and get a response', async ({ page }) => {
    // Enable console logging from the browser
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('Browser ERROR:', msg.text());
      } else {
        console.log('Browser:', msg.text());
      }
    });

    // Enable request/response logging
    page.on('requestfailed', request => {
      console.log('Request FAILED:', request.url(), request.failure()?.errorText);
    });

    page.on('response', response => {
      if (response.url().includes('/api/')) {
        console.log('API Response:', response.status(), response.url());
      }
    });

    // Login first
    await page.goto('http://localhost:8081/login');
    await page.waitForLoadState('networkidle');

    // Fill credentials and login
    await page.locator('input[placeholder*="mail" i]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);

    const submitButton = page.locator('div[tabindex="0"][class*="r-backgroundColor"]').filter({
      hasText: /^Submit$/
    });
    if (await submitButton.count() > 0) {
      await submitButton.first().click();
    } else {
      await page.locator('div[tabindex="0"]').filter({ hasText: 'Submit' }).last().click();
    }

    // Wait for redirect to home/chat
    await page.waitForURL('**/', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/chat-01-home.png' });
    console.log('Logged in, URL:', page.url());

    // Look for chat input
    const inputs = await page.locator('input, textarea').all();
    console.log('Found input elements:', inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      const placeholder = await inputs[i].getAttribute('placeholder');
      const tag = await inputs[i].evaluate(el => el.tagName);
      console.log(`Input ${i}: ${tag}, placeholder="${placeholder}"`);
    }

    // Find chat input (usually a TextInput with placeholder about asking)
    const chatInput = page.locator('input[placeholder*="ask" i], textarea[placeholder*="ask" i], input[placeholder*="message" i], textarea[placeholder*="message" i]').first();
    const chatInputCount = await chatInput.count();
    console.log('Found chat input:', chatInputCount);

    if (chatInputCount === 0) {
      // Try to find any text input that's not email/password
      const allInputs = await page.locator('input:not([type="email"]):not([type="password"]), textarea').all();
      console.log('All other inputs:', allInputs.length);
      for (const inp of allInputs) {
        const ph = await inp.getAttribute('placeholder');
        console.log('  placeholder:', ph);
      }
      await page.screenshot({ path: 'test-results/chat-02-no-input.png' });
    }

    // Type a question
    const question = 'What is the meaning of bismillah?';

    // Try to find and fill the chat input
    const possibleInputs = page.locator('input, textarea').filter({
      hasNot: page.locator('[type="email"], [type="password"], [type="checkbox"]')
    });
    const inputCount = await possibleInputs.count();
    console.log('Possible chat inputs:', inputCount);

    if (inputCount > 0) {
      // Use the first visible non-email/password input
      for (let i = 0; i < inputCount; i++) {
        const inp = possibleInputs.nth(i);
        const isVisible = await inp.isVisible();
        const placeholder = await inp.getAttribute('placeholder');
        console.log(`Checking input ${i}: visible=${isVisible}, placeholder="${placeholder}"`);

        if (isVisible && placeholder && !placeholder.toLowerCase().includes('email') && !placeholder.toLowerCase().includes('password')) {
          await inp.fill(question);
          console.log('Filled question in input:', i);
          await page.screenshot({ path: 'test-results/chat-03-question-filled.png' });
          break;
        }
      }
    }

    // Look for send button
    const sendButtons = await page.locator('[role="button"], div[tabindex="0"]').filter({
      hasText: /send|ask|submit/i
    }).all();
    console.log('Found send-like buttons:', sendButtons.length);

    // Also look for icon buttons (might be an arrow or send icon)
    const iconButtons = await page.locator('svg, [class*="send"], [class*="arrow"]').all();
    console.log('Found icon elements:', iconButtons.length);

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/chat-04-before-send.png' });

    // Try pressing Enter to send
    await page.keyboard.press('Enter');
    console.log('Pressed Enter to send');

    // Wait for the response to start appearing (look for "Ansari Chat" response)
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/chat-05-response-start.png' });

    // Wait for loading to complete (spinner should disappear or response should be longer)
    // The loading spinner has a specific class or the response text gets longer
    let lastResponseLength = 0;
    let stableCount = 0;
    for (let i = 0; i < 20; i++) { // Max 20 iterations (20 seconds)
      await page.waitForTimeout(1000);

      // Get all text content from Ansari responses
      const responseTexts = await page.locator('text=/Ansari Chat/i').locator('..').locator('..').allTextContents();
      const totalLength = responseTexts.join('').length;

      console.log(`Response check ${i}: length=${totalLength}`);

      if (totalLength === lastResponseLength && totalLength > 50) {
        stableCount++;
        if (stableCount >= 2) {
          console.log('Response appears complete (stable for 2 seconds)');
          break;
        }
      } else {
        stableCount = 0;
      }
      lastResponseLength = totalLength;
    }

    await page.screenshot({ path: 'test-results/chat-06-response-complete.png' });

    // Verify response contains meaningful content
    const pageContent = await page.content();

    // Check for error messages
    if (pageContent.toLowerCase().includes('error fetching') || pageContent.includes('errorMsg=')) {
      const errorTexts = await page.locator('text=/error/i').allTextContents();
      console.log('ERROR: Page contains error:', errorTexts);
      throw new Error('Chat response contained errors');
    }

    // Verify the response contains some Islamic content or meaningful answer
    const hasResponse = pageContent.includes('Ansari Chat') &&
      (pageContent.includes('Bismillah') ||
       pageContent.includes('بسم الله') ||
       pageContent.includes('In the name') ||
       pageContent.includes('Arabic') ||
       pageContent.includes('search'));

    console.log('Has meaningful response:', hasResponse);
    expect(hasResponse).toBe(true);

    console.log('Final URL:', page.url());
    console.log('Chat test completed successfully');
  });
});
