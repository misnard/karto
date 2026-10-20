import { useState } from 'react';
import { type ContractCheckResponse, ContractCheckResponseSchema, type Message } from '../state.ts';

/** Dev builds only: asks the service worker for read-only checks in the store tab and shows OK/KO per check. */
export function ContractCheck() {
  const [results, setResults] = useState<ContractCheckResponse | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const answer: unknown = await chrome.runtime.sendMessage({ type: 'checkContract' } satisfies Message);
      setResults(ContractCheckResponseSchema.parse(answer));
    } catch (err) {
      console.error('[karto] contract check failed', err);
      setResults([{ name: 'Service worker', ok: false, detail: String(err) }]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-label="Vérification du contrat">
      <button type="button" className="btn btn-secondary" onClick={run} disabled={running}>
        {running ? 'Vérification…' : 'Vérifier le contrat Carrefour'}
      </button>
      {results && (
        <ul className="list">
          {results.map((result) => (
            <li key={result.name} className="row">
              <span className={`badge badge-${result.ok ? 'ok' : 'danger'}`}>{result.ok ? 'OK' : 'KO'}</span>
              <div className="row-main">
                <span>{result.name}</span>
                <span className="small muted">{result.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
