import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
const swift=spawnSync('swiftc',['--version'],{stdio:'ignore'}).status===0;
test('native staging channels accept only their independently selected identity and origin',{skip:!swift},t=>{
 const root=mkdtempSync(path.join(tmpdir(),'kordi-staging-swift-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cases=['app','research'].map(edition=>{
  const tag=edition==='research'?'research.staging':'staging';
  return {edition,environment:'staging',backendOrigin:`https://${tag}.example.test`,callbackScheme:'sample-'+tag.replaceAll('.','-'),iosIdentifier:'test.ios.'+tag,iosShareIdentifier:'test.ios.'+tag+'.share',appGroup:'group.test.'+tag,credentialService:'test.credentials.'+tag};
 });
 const main=path.join(root,'main.swift');
 writeFileSync(main,`import Foundation
let cases = ${JSON.stringify(cases.map(v=>Buffer.from(JSON.stringify(v)).toString('base64')))}
for encoded in cases {
    let expected = KordiReleaseConfiguration.read(["KordiExpectedDistribution": encoded])!
    let info: [String: Any] = ["KordiExpectedDistribution": encoded, "KordiDistributionChannel": expected.channel, "KordiCloudBaseURL": expected.backendOrigin, "KordiOAuthCallbackScheme": expected.callbackScheme]
    let app = try KordiAppEnvironment.configured(infoDictionary: info, bundleIdentifier: expected.iosIdentifier)
    precondition(app.channel.rawValue.contains("staging"))
    var wrong = info; wrong["KordiDistributionChannel"] = expected.edition == "app" ? "production" : "research"
    precondition((try? KordiAppEnvironment.configured(infoDictionary: wrong, bundleIdentifier: expected.iosIdentifier)) == nil)
    precondition((try? KordiAppEnvironment.configured(infoDictionary: info, bundleIdentifier: "ai.kordi.ios.beta")) == nil)
    wrong = info; wrong["KordiCloudBaseURL"] = "https://production.example.test"
    precondition((try? KordiAppEnvironment.configured(infoDictionary: wrong, bundleIdentifier: expected.iosIdentifier)) == nil)
}
`);
 const result=spawnSync('swiftc',['-D','BETA','-module-cache-path',path.join(root,'cache'),'app/ios/Kordi/Core/Environment/KordiReleaseConfiguration.swift','app/ios/Kordi/Core/Environment/KordiAppEnvironment.swift',main,'-o',path.join(root,'verify')],{encoding:'utf8',timeout:120000});
 assert.equal(result.status,0,result.stderr);assert.equal(spawnSync(path.join(root,'verify'),[],{encoding:'utf8'}).status,0);
});
