import { AppShellFrame } from '@/app/AppShellFrame';
import { useKordiAppModel } from '@/app/useKordiAppModel';

export default function KordiApp() {
  const appShellFrameProps = useKordiAppModel();
  return <AppShellFrame {...appShellFrameProps} />;
}
