import {useHostLink} from '@saga-a2ui/react-mcp-stack/faithful-card';

const REPOSITORY = 'https://github.com/MachineWisdomAI/saga-a2ui';

/**
 * Optional application credit, separate from the unchanged upstream answer. It follows the card's
 * own link rules (`useHostLink`): the enclosing view's policy decides, the host is asked once per
 * activation, and a new answer drops an outcome that belonged to the previous one.
 */
export function SagaCredit({enabled}: {readonly enabled: boolean}) {
  const link = useHostLink(REPOSITORY);
  if (!enabled) return null;
  return <footer className="saga-credit" data-testid="saga-credit" dir="ltr">
    Built with {link.allowed
      ? <button type="button" onClick={() => { void link.open(); }}>saga a2ui</button>
      : <span>saga a2ui</span>}
    <span role="status">{link.outcome?.message ?? ''}</span>
  </footer>;
}
