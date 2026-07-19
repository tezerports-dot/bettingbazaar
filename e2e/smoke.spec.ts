// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { test, expect } from '@playwright/test';

test('basic user betting flow in mock mode', async ({ page }) => {
  // 1. Visit landing page
  await page.goto('/');
  
  // 2. Expect Auth Wall
  await expect(page.locator('h1')).toContainText('BAZAAR CLASH');
  
  // 3. Perform Login (Assuming mock mode defaults work)
  await page.fill('input[placeholder="9876543210"]', '9876543210');
  await page.fill('input[placeholder="••••••••"]', 'admin123');
  
  // Solve Captcha (mock handles simple addition)
  const captchaText = await page.textContent('div.text-lg.tracking-widest');
  if (captchaText) {
      const match = captchaText.match(/(\d+) \+ (\d+)/);
      if (match) {
          const result = parseInt(match[1]) + parseInt(match[2]);
          await page.fill('input[placeholder="Ans"]', result.toString());
      }
  }

  await page.click('button:has-text("ENTER ARENA")');

  // 4. Check if Main Page loaded
  await expect(page.locator('h2')).toContainText('DELHI BAZAAR');

  // 5. Select a chip and verify state
  await page.click('button:has-text("10")');
  
  // 6. Click Delhi card
  await page.click('button:has-text("Delhi")');

  // 7. Verify feedback (e.g., balance update or toast)
  // Since we're in mock mode, things happen instantly.
  await expect(page.locator('text=Bet Placed')).toBeVisible();
});
