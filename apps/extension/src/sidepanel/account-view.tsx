import type { Device } from '@karto/contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { createPairingCode, createUser, listDevices, revokeDevice } from '../api.ts';
import { Shell } from './shell.tsx';
import { errorText, formatDate, isUnauthorized } from './ui.ts';

interface Props {
  token: string;
  isAdmin: boolean;
  onBack: () => void;
  onUnauthorized: () => void;
}

type Code = { code: string; expiresAt: number };

/** Devices of the user (list, revoke, pair another one) and, for admins, user creation. */
export function AccountView({ token, isAdmin, onBack, onUnauthorized }: Props) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState<Code | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<(Code & { name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    listDevices(token)
      .then(setDevices)
      .catch((err: unknown) => {
        if (isUnauthorized(err)) onUnauthorized();
        else setError(errorText(err));
      });
  }, [token, onUnauthorized]);

  function revoke(device: Device) {
    if (!window.confirm(`Révoquer « ${device.label} » ? Ce navigateur devra être appairé à nouveau.`)) return;
    void run(async () => {
      await revokeDevice(token, device.id);
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null);
    });
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const { user, code, expiresAt } = await createUser(token, name.trim());
      setCreated({ name: user.name, code, expiresAt });
      setName('');
    });
  }

  return (
    <Shell
      action={
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Retour
        </button>
      }
    >
      <section className="stack" aria-labelledby="devices-title">
        <h1 className="title" id="devices-title">
          Appareils
        </h1>
        <p className="lead">Les navigateurs reliés à ton compte Karto.</p>
      </section>
      {devices && (
        <ul className="list">
          {devices.map((device) => (
            <li key={device.id} className="row device">
              <div className="row-main">
                <span className="row-name">{device.label}</span>
                <span className="small muted">
                  Relié le {formatDate(device.createdAt)}
                  {device.lastSeenAt !== null && ` · vu le ${formatDate(device.lastSeenAt)}`}
                </span>
              </div>
              {device.current ? (
                <span className="chip">Cet appareil</span>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => revoke(device)} disabled={busy}>
                  Révoquer
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-block"
        disabled={busy}
        onClick={() => run(async () => setPairing(await createPairingCode(token)))}
      >
        Appairer un autre appareil
      </button>
      {pairing && (
        <CodeBox {...pairing} hint="Sur l’autre navigateur, installe Karto, ouvre le panneau et entre ce code." />
      )}

      {isAdmin && (
        <section className="stack" aria-labelledby="admin-title">
          <h2 className="section-title" id="admin-title">
            Admin
          </h2>
          <form className="form" onSubmit={create}>
            <div className="field">
              <label htmlFor="new-user">Nom du nouvel utilisateur</label>
              <input id="new-user" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || name.trim() === ''}>
              Créer l’utilisateur
            </button>
          </form>
          {created && (
            <CodeBox
              {...created}
              hint={`Envoie ce code à ${created.name} : il l’entre dans Karto pour relier son navigateur.`}
            />
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </Shell>
  );
}

function CodeBox({ code, expiresAt, hint }: Code & { hint: string }) {
  return (
    <div role="status" className="stack code-box">
      <output className="code-input">{code}</output>
      <span className="small muted">
        {hint} Il ne sert qu’une fois, jusqu’au {formatDate(expiresAt)}.
      </span>
    </div>
  );
}
