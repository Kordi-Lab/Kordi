import { runSyntheticHostedTurn, type HostedRoute, type ProviderMaterial } from './worker';

try {
  const input = JSON.parse(await Bun.stdin.text()) as {
    route: HostedRoute;
    material: ProviderMaterial;
  };
  const result = await runSyntheticHostedTurn(input.route, input.material);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Synthetic OMP worker rejected the route or material.\n');
  process.exitCode = 1;
}
