import { test, expect } from '@playwright/test';

test.describe('Registration Flow', () => {
  test('can create a new account', async ({ page }) => {
    // Generate unique email
    const timestamp = Date.now();
    const email = `test${timestamp}@example.com`;
    // Password must have: 8+ chars, 1 uppercase, 1 number, 1 symbol
    const password = 'TestPassword123!';

    // Go to the frontend
    await page.goto('http://localhost:8081');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/01-landing.png' });

    // Click Register link
    await page.click('text=Register');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/02-register-page.png' });

    // Log page content to understand the form
    const pageContent = await page.content();
    console.log('Page HTML snippet:', pageContent.substring(0, 3000));

    // Try to find and fill form fields
    // Look for input fields
    const inputs = await page.locator('input').all();
    console.log('Found inputs:', inputs.length);

    for (let i = 0; i < inputs.length; i++) {
      const placeholder = await inputs[i].getAttribute('placeholder');
      const type = await inputs[i].getAttribute('type');
      const name = await inputs[i].getAttribute('name');
      console.log(`Input ${i}: type=${type}, name=${name}, placeholder=${placeholder}`);
    }

    // Fill email field
    const emailField = page.locator('input[placeholder*="mail" i]').first();
    await emailField.fill(email);
    console.log('Filled email:', email);

    // Fill first name (optional but let's fill it)
    const firstNameField = page.locator('input[placeholder*="first" i]').first();
    if (await firstNameField.count() > 0) {
      await firstNameField.fill('Test');
      console.log('Filled first name');
    }

    // Fill last name (optional but let's fill it)
    const lastNameField = page.locator('input[placeholder*="last" i]').first();
    if (await lastNameField.count() > 0) {
      await lastNameField.fill('User');
      console.log('Filled last name');
    }

    // Fill password fields - there should be two (password and confirm)
    const passwordFields = await page.locator('input[type="password"]').all();
    console.log('Found password fields:', passwordFields.length);

    for (const field of passwordFields) {
      await field.fill(password);
    }
    console.log('Filled password fields');

    await page.screenshot({ path: 'test-results/03-form-filled.png' });

    // The Register button is a Pressable (div with tabindex=0 and r-cursor-1loqt21)
    // containing a text div with "Register"
    // From the HTML analysis:
    // <div tabindex="0" class="...r-cursor-1loqt21...">
    //   <div>Register</div>
    // </div>

    // Use Playwright's locator to find the Pressable (parent of Register text)
    // that has tabindex=0 and contains the text
    const registerButton = page.locator('div[tabindex="0"]').filter({
      hasText: /^Register$/
    }).filter({
      has: page.locator('.r-cursor-1loqt21, [class*="cursor"]')
    });

    let buttonCount = await registerButton.count();
    console.log('Found Register buttons with tabindex:', buttonCount);

    // If that doesn't work, try a simpler approach:
    // find all divs with tabindex=0 that have Register as direct child text
    if (buttonCount === 0) {
      // Alternative: look for the element by its structure
      // The submit button has specific classes including r-backgroundColor-htarbu
      const altButton = page.locator('div[tabindex="0"]').filter({ hasText: 'Register' });
      buttonCount = await altButton.count();
      console.log('Found divs with tabindex and Register text:', buttonCount);

      // Log all of them
      for (let i = 0; i < buttonCount; i++) {
        const classes = await altButton.nth(i).getAttribute('class');
        console.log(`Button ${i}: ${classes?.substring(0, 80)}...`);
      }
    }

    // The submit button should have backgroundColor class (it's styled as a button)
    // It should be the one with r-backgroundColor-htarbu class
    const submitButton = page.locator('div[tabindex="0"][class*="r-backgroundColor"]').filter({
      hasText: /^Register$/
    });
    buttonCount = await submitButton.count();
    console.log('Found styled submit button:', buttonCount);

    // Set up response listener before clicking
    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/v2/users/register'),
      { timeout: 10000 }
    ).catch(e => {
      console.log('Response timeout:', e.message);
      return null;
    });

    if (buttonCount > 0) {
      console.log('Clicking submit button with Playwright...');
      await submitButton.first().click();
    } else {
      // Fallback: click the last element with Register text that has tabindex
      console.log('Using fallback: clicking last tabindex div with Register');
      const fallbackButton = page.locator('div[tabindex="0"]').filter({ hasText: 'Register' }).last();
      await fallbackButton.click();
    }

    const response = await responsePromise;

    if (response) {
      console.log('Registration response status:', response.status());
      const body = await response.text();
      console.log('Registration response body:', body);

      // Verify response structure (frontend expects status: 'success')
      const data = JSON.parse(body);
      expect(data.status).toBe('success');
      expect(data.access_token).toBeTruthy();
      expect(data.refresh_token).toBeTruthy();
      expect(data.token_type).toBe('bearer');

      console.log('API response verified successfully');
    } else {
      throw new Error('No registration API response captured');
    }

    // Wait for redirect to login page
    await page.waitForURL('**/login**', { timeout: 5000 }).catch(() => {
      console.log('Redirect to login not detected, checking current state...');
    });

    await page.screenshot({ path: 'test-results/04-after-submit.png' });

    // Check final URL - should redirect to login after successful registration
    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);
    expect(finalUrl).toContain('/login');
    console.log('SUCCESS: Full registration flow completed with redirect');
  });
});
