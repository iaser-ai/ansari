import { test, expect } from '@playwright/test';

test.describe('Login Flow', () => {
  // First register a user, then test login
  const timestamp = Date.now();
  const email = `logintest${timestamp}@example.com`;
  const password = 'TestPassword123!';

  test.beforeAll(async ({ request }) => {
    // Register a user via API first
    const response = await request.post('http://localhost:3000/api/v2/users/register', {
      data: {
        email,
        password,
        first_name: 'Login',
        last_name: 'Test',
      },
    });
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('success');
    console.log('Test user registered:', email);
  });

  test('can login with valid credentials', async ({ page }) => {
    // Go to login page
    await page.goto('http://localhost:8081/login');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/login-01-page.png' });

    // Fill email
    const emailField = page.locator('input[placeholder*="mail" i]').first();
    await emailField.fill(email);
    console.log('Filled email:', email);

    // Fill password
    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.fill(password);
    console.log('Filled password');

    await page.screenshot({ path: 'test-results/login-02-filled.png' });

    // Set up response listener
    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/v2/users/login'),
      { timeout: 10000 }
    );

    // Click submit button (styled div with tabindex and background color)
    const submitButton = page.locator('div[tabindex="0"][class*="r-backgroundColor"]').filter({
      hasText: /^Submit$/
    });

    const buttonCount = await submitButton.count();
    console.log('Found submit buttons:', buttonCount);

    if (buttonCount > 0) {
      await submitButton.first().click();
    } else {
      // Fallback: click last tabindex div with Submit text
      const fallback = page.locator('div[tabindex="0"]').filter({ hasText: 'Submit' }).last();
      await fallback.click();
    }

    const response = await responsePromise;
    console.log('Login response status:', response.status());
    const body = await response.json();
    console.log('Login response:', JSON.stringify(body).substring(0, 200));

    // Verify response
    expect(response.status()).toBe(200);
    expect(body.status).toBe('success');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    // Wait for navigation to chat/home
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/login-03-after.png' });

    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);

    // Should redirect away from login page
    expect(finalUrl).not.toContain('/login');
  });

  test('shows error for invalid credentials', async ({ page }) => {
    await page.goto('http://localhost:8081/login');
    await page.waitForLoadState('networkidle');

    // Fill wrong credentials
    const emailField = page.locator('input[placeholder*="mail" i]').first();
    await emailField.fill('wrong@example.com');

    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.fill('WrongPassword123!');

    // Click submit
    const submitButton = page.locator('div[tabindex="0"][class*="r-backgroundColor"]').filter({
      hasText: /^Submit$/
    });

    if (await submitButton.count() > 0) {
      await submitButton.first().click();
    } else {
      const fallback = page.locator('div[tabindex="0"]').filter({ hasText: 'Submit' }).last();
      await fallback.click();
    }

    // Wait for error response
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/login-04-error.png' });

    // Should still be on login page (failed login)
    expect(page.url()).toContain('/login');
  });
});
