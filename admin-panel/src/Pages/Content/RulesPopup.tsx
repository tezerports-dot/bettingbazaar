// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Rules Pop-up — the board rules players read and accept before their
 * first bet (owner, 2026-10-14: "as we grow and add new rules or remove old
 * rules or info we need it editable").
 *
 * The text, its placeholders and its limits are the server's
 * (`GET /api/admin/board-rules`, backend/routes/admin/boardRules.admin.routes.js);
 * this screen edits a copy and publishes it whole. Every publish is a new
 * version, and every player is asked to accept it again before their next bet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { boardRules, type BoardRulesTextDraft, type BoardRulesPreview } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface Limits { headingMax: number; introMax: number; sectionsMax: number; titleMax: number; bodyMax: number }
interface Published { version: number; heading: string; publishedBy: string | null; publishedAt: string }

const errorText = (e: any, fallback: string) => e?.response?.data?.message || e?.message || fallback;

export const RulesPopup: React.FC = () => {
  const [draft, setDraft] = useState<BoardRulesTextDraft | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<BoardRulesPreview | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Limits | null>(null);
  const [history, setHistory] = useState<Published[]>([]);
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res: any = await boardRules.get();
      if (!res?.success) throw new Error(res?.message || 'Could not load the rules pop-up');
      const text = { heading: res.text.heading, intro: res.text.intro, sections: res.text.sections };
      setDraft(text);
      setSaved(JSON.stringify(text));
      setVersion(res.text.version);
      setPreview(res.preview);
      setTokens(res.tokens ?? {});
      setLimits(res.limits ?? null);
      setHistory(res.history ?? []);
    } catch (e: any) {
      setError(errorText(e, 'Could not load the rules pop-up'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !draft) return <div role="alert" className="card p-6 text-sm text-red-400">{error}</div>;
  if (!draft || !limits) return <div role="status" className="card p-6 text-sm text-gray-400">Loading…</div>;

  const changed = JSON.stringify(draft) !== saved;
  const setSection = (i: number, patch: Partial<{ title: string; body: string }>) =>
    setDraft({ ...draft, sections: draft.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, by: number) => {
    const next = [...draft.sections];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    setDraft({ ...draft, sections: next });
  };

  const publish = async () => {
    setConfirming(false);
    setPublishing(true);
    setError('');
    try {
      const res: any = await boardRules.publish(draft);
      if (!res?.success) throw new Error(res?.message || 'Publish failed');
      toast.success(`Published as version ${res.text.version}. Players accept it before their next bet.`);
      await load();
    } catch (e: any) {
      setError(errorText(e, 'Publish failed'));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="card p-5 space-y-2">
        <h2 className="text-lg font-semibold">Rules pop-up <span className="text-sm text-gray-500 font-normal">version {version}</span></h2>
        <p className="text-sm text-gray-400">
          Players see this before their first bet and on the Rules page. Publishing makes a new version: every player
          is shown it again and must accept it before their next bet.
        </p>
        {Object.keys(tokens).length > 0 && (
          <div className="text-xs text-gray-400">
            <p className="font-semibold text-gray-300">Placeholders filled in from the live settings, so the text never goes stale:</p>
            <ul className="list-disc ml-5">
              {Object.entries(tokens).map(([name, what]) => (
                <li key={name}><code className="text-gold-400">{`{${name}}`}</code> {what}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <label className="label" htmlFor="rules-heading">Heading</label>
          <input id="rules-heading" className="input" maxLength={limits.headingMax}
            value={draft.heading} onChange={(e) => setDraft({ ...draft, heading: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="rules-intro">Intro line (optional)</label>
          <textarea id="rules-intro" className="input min-h-[60px]" maxLength={limits.introMax}
            value={draft.intro} onChange={(e) => setDraft({ ...draft, intro: e.target.value })} />
        </div>

        {draft.sections.map((s, i) => (
          <fieldset key={i} className="p-3 bg-dark-800 rounded-lg space-y-2">
            <legend className="sr-only">Rule {i + 1}</legend>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-14">Rule {i + 1}</span>
              <input aria-label={`Rule ${i + 1} title`} className="input flex-1" maxLength={limits.titleMax}
                value={s.title} onChange={(e) => setSection(i, { title: e.target.value })} />
              <button type="button" aria-label={`Move rule ${i + 1} up`} disabled={i === 0}
                onClick={() => move(i, -1)} className="p-2 rounded hover:bg-dark-700 disabled:opacity-30"><ArrowUp size={16} /></button>
              <button type="button" aria-label={`Move rule ${i + 1} down`} disabled={i === draft.sections.length - 1}
                onClick={() => move(i, 1)} className="p-2 rounded hover:bg-dark-700 disabled:opacity-30"><ArrowDown size={16} /></button>
              <button type="button" aria-label={`Remove rule ${i + 1}`} disabled={draft.sections.length === 1}
                onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) })}
                className="p-2 rounded hover:bg-dark-700 text-red-400 disabled:opacity-30"><Trash2 size={16} /></button>
            </div>
            <textarea aria-label={`Rule ${i + 1} text`} className="input min-h-[80px]" maxLength={limits.bodyMax}
              value={s.body} onChange={(e) => setSection(i, { body: e.target.value })} />
          </fieldset>
        ))}

        <button type="button" className="btn-secondary flex items-center gap-2"
          disabled={draft.sections.length >= limits.sectionsMax}
          onClick={() => setDraft({ ...draft, sections: [...draft.sections, { title: '', body: '' }] })}>
          <Plus size={16} /> Add a rule
        </button>
      </div>

      {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
      <div className="flex gap-3">
        <button type="button" className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!changed || publishing} onClick={() => setConfirming(true)}>
          <Save size={16} /> {publishing ? 'Publishing…' : 'Publish'}
        </button>
        <button type="button" className="btn-secondary disabled:opacity-50" disabled={!changed || publishing}
          onClick={() => setDraft(JSON.parse(saved))}>Discard changes</button>
      </div>

      {preview && (
        <div className="card p-5 space-y-2">
          <h3 className="font-semibold">What players see now (version {version})</h3>
          <p className="font-semibold">{preview.heading}</p>
          {preview.intro && <p className="text-xs text-gray-400 whitespace-pre-line">{preview.intro}</p>}
          {preview.sections.map((s, i) => (
            <div key={i}>
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs text-gray-400 whitespace-pre-line">{s.body}</p>
            </div>
          ))}
          {preview.phantomBetsNotice && (
            <p className="text-xs text-gray-300 border-t border-dark-700 pt-2">
              ⓘ {preview.phantomBetsNotice} <span className="text-gray-500">(always added; reword it under Settings › Phantom Bets Line)</span>
            </p>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="card p-5">
          <h3 className="font-semibold mb-2">Published versions</h3>
          <ul className="text-xs text-gray-400 space-y-1">
            {history.map((h) => (
              <li key={h.version}>Version {h.version}: {h.heading}, {new Date(h.publishedAt).toLocaleString('en-IN')}</li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={publish}
        title="Publish the rules pop-up"
        message="Every player will be shown the new rules and must accept them before their next bet."
        type="warning"
      />
    </div>
  );
};

export default RulesPopup;
