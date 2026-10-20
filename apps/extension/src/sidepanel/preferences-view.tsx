import type { Preferences } from '@karto/contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { getApiUrl, savePreferences } from '../api.ts';
import { Shell } from './shell.tsx';
import { errorText, isUnauthorized } from './ui.ts';

type Diet = Preferences['diet'][number];
type Goal = Preferences['goals'][number];

const DIETS: { value: Diet; label: string }[] = [
  { value: 'vegetarian', label: 'Végétarien' },
  { value: 'vegan', label: 'Vegan' },
  { value: 'gluten_free', label: 'Sans gluten' },
  { value: 'lactose_free', label: 'Sans lactose' },
  { value: 'no_pork', label: 'Sans porc' },
  { value: 'halal', label: 'Halal' },
];

const GOALS: { value: Goal; label: string }[] = [
  { value: 'high_protein', label: 'Riche en protéines' },
  { value: 'low_calorie', label: 'Pauvre en calories' },
  { value: 'low_sugar', label: 'Peu sucré' },
  { value: 'low_fat', label: 'Peu gras' },
  { value: 'low_salt', label: 'Peu salé' },
];

const ORGANIC = [
  { value: 'no', label: 'Peu importe' },
  { value: 'prefer', label: 'De préférence' },
  { value: 'require', label: 'Toujours' },
] as const;

const PRIVATE_LABEL = [
  { value: 'prefer', label: 'De préférence' },
  { value: 'neutral', label: 'Peu importe' },
  { value: 'avoid', label: 'À éviter' },
] as const;

const PACK_SIZE = [
  { value: 'small', label: 'Petits' },
  { value: 'neutral', label: 'Peu importe' },
  { value: 'value', label: 'Économiques' },
] as const;

const toList = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  ),
];
const fromList = (list: string[]) => list.join(', ');

interface Props {
  token: string;
  initial: Preferences;
  onSaved: (preferences: Preferences) => void;
  onBack: () => void;
  onUnauthorized: () => void;
  /** Unpairs this browser, back to the pairing screen. */
  onChangeServer: () => void;
}

export function PreferencesView({ token, initial, onSaved, onBack, onUnauthorized, onChangeServer }: Props) {
  const [prefs, setPrefs] = useState(initial);
  const [budget, setBudget] = useState(initial.budgetCents ? String(initial.budgetCents / 100) : '');
  const [allergies, setAllergies] = useState(fromList(initial.allergies));
  const [favorites, setFavorites] = useState(fromList(initial.favoriteBrands));
  const [banned, setBanned] = useState(fromList(initial.bannedBrands));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setPrefs((p) => ({ ...p, [key]: value }));
  const toggleDiet = (diet: Diet) =>
    set('diet', prefs.diet.includes(diet) ? prefs.diet.filter((d) => d !== diet) : [...prefs.diet, diet]);
  const toggleGoal = (goal: Goal) =>
    set('goals', prefs.goals.includes(goal) ? prefs.goals.filter((g) => g !== goal) : [...prefs.goals, goal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const euros = Number(budget.replace(',', '.'));
    try {
      const saved = await savePreferences(token, {
        ...prefs,
        budgetCents: budget.trim() && euros > 0 ? Math.round(euros * 100) : undefined,
        allergies: toList(allergies),
        favoriteBrands: toList(favorites),
        bannedBrands: toList(banned),
        notes: prefs.notes?.trim() || undefined,
      });
      onSaved(saved);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      action={
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Retour
        </button>
      }
    >
      <form className="form" id="preferences" onSubmit={submit}>
        <div className="stack">
          <h1 className="title">Tes préférences</h1>
          <p className="lead">
            Elles s’appliquent à chaque panier. Karto les suit au mieux, sans garantie sur les allergènes.
          </p>
        </div>

        <fieldset className="group">
          <legend>Régime</legend>
          <div className="chips">
            {DIETS.map((diet) => (
              <label key={diet.value} className="check-chip">
                <input
                  type="checkbox"
                  checked={prefs.diet.includes(diet.value)}
                  onChange={() => toggleDiet(diet.value)}
                />
                <span className="chip-face">{diet.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="group">
          <legend>Objectifs</legend>
          <div className="chips">
            {GOALS.map((goal) => (
              <label key={goal.value} className="check-chip">
                <input
                  type="checkbox"
                  checked={prefs.goals.includes(goal.value)}
                  onChange={() => toggleGoal(goal.value)}
                />
                <span className="chip-face">{goal.label}</span>
              </label>
            ))}
          </div>
          <span className="small muted">
            Karto privilégie les variantes adaptées et un meilleur Nutri-Score, sans compter les calories.
          </span>
        </fieldset>

        <div className="field">
          <label htmlFor="allergies">Allergies</label>
          <input
            id="allergies"
            value={allergies}
            onChange={(e) => setAllergies(e.target.value)}
            placeholder="arachide, fruits à coque"
          />
          <span className="small muted">Séparées par des virgules. Karto évite ces ingrédients dans les plats.</span>
        </div>

        <Segmented
          legend="Bio"
          name="organic"
          options={ORGANIC}
          value={prefs.organic}
          onChange={(v) => set('organic', v)}
        />
        <Segmented
          legend="Marques distributeur"
          name="privateLabel"
          options={PRIVATE_LABEL}
          value={prefs.privateLabel}
          onChange={(v) => set('privateLabel', v)}
        />
        <Segmented
          legend="Formats"
          name="packSize"
          options={PACK_SIZE}
          value={prefs.packSize}
          onChange={(v) => set('packSize', v)}
        />

        <div className="field">
          <label htmlFor="favorites">Marques préférées</label>
          <input id="favorites" value={favorites} onChange={(e) => setFavorites(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="banned">Marques à ne jamais prendre</label>
          <input id="banned" value={banned} onChange={(e) => setBanned(e.target.value)} />
        </div>

        <div className="inline-field">
          <label htmlFor="budget">Budget par panier (€)</label>
          <input
            id="budget"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="aucun"
          />
        </div>

        <div className="field">
          <label htmlFor="notes">Autres consignes</label>
          <textarea
            id="notes"
            className="notes"
            value={prefs.notes ?? ''}
            onChange={(e) => set('notes', e.target.value)}
            maxLength={2000}
            placeholder="Pas de produits ultra-transformés, lait demi-écrémé plutôt qu’entier…"
          />
        </div>

        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </form>
      <ServerSection onChangeServer={onChangeServer} />
    </Shell>
  );
}

function ServerSection({ onChangeServer }: { onChangeServer: () => void }) {
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    getApiUrl()
      .then(setServer)
      .catch((err: unknown) => console.error('[karto] could not read the server address', err));
  }, []);

  function change() {
    if (confirm('Changer de serveur délie ce navigateur : il faudra un nouveau code d’appairage. Continuer ?')) {
      onChangeServer();
    }
  }

  return (
    <section className="stack" aria-labelledby="server-title">
      <h2 className="section-title" id="server-title">
        Serveur Karto
      </h2>
      <p className="small muted">{server ?? 'Aucun'}</p>
      <button type="button" className="btn btn-secondary" onClick={change}>
        Changer de serveur
      </button>
    </section>
  );
}

function Segmented<V extends string>(props: {
  legend: string;
  name: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <fieldset className="group">
      <legend>{props.legend}</legend>
      <div className="segmented">
        {props.options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={props.name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span className="segment-face">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
