import {test,expect} from '@playwright/test';

for (const viewer of ['owner','peer']) {
  test(`one pending reply is rendered for an iOS request in the ${viewer} view`, async ({page}) => {
    await page.addInitScript(viewer => Object.assign(window,{fixtureIncomingReply:viewer}),viewer);
    for (let reload=0;reload<2;reload++) {
      await page.goto('/tests/visual/subsessionConversation.html');
      await expect(page.getByRole('button',{name:'Stop agent request',exact:true})).toHaveCount(1);
      await expect(page.getByText('Owner · Alex',{exact:true})).toHaveCount(viewer==='owner'?0:2);
      await expect(page.getByRole('textbox')).toBeVisible();
    }
  });
}
