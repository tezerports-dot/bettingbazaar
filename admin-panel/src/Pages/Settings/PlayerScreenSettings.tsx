// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Player Screen — the switches for the player app's extras
 * (owner, 2026-10-10): `SystemConfig.boardExtras`, declared in
 * database/spec/config.spec.js and served to every player in
 * `systemConfigPayload`. A save goes out to every open player app at once
 * (the `system_config` push), so a switch takes effect without a reload.
 *
 * Presentation only. None of these shows a figure the platform does not
 * already send that player: their own timer, their own payout, their own
 * bonus turnover, and the promo cards published under Page Slides › Home.
 */
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { system } from '../../services/api';

interface BoardExtras {
  urgencyChips: boolean;
  closingWarnSeconds: number;
  resultCelebration: boolean;
  bonusProgress: boolean;
  promoCards: boolean;
}

// Schema defaults (config.spec.js `boardExtras`), shown until the GET lands.
const DEFAULTS: BoardExtras = {
  urgencyChips: true,       // schema default: true
  closingWarnSeconds: 10,   // schema default: 10
  resultCelebration: true,  // schema default: true
  bonusProgress: true,      // schema default: true
  promoCards: true,         // schema default: true
};

const SWITCHES: { key: Exclude<keyof BoardExtras, 'closingWarnSeconds'>; label: string; where: string; what: string }[] = [
  { key: 'urgencyChips', label: 'Closing warning', where: 'Board timer and betting cards',
    what: 'The timer turning amber then red, and a "Closing 0:09" chip on the betting cards in the last seconds.' },
  { key: 'resultCelebration', label: 'Result celebration', where: 'Board, on the result',
    what: 'The winning side in large type and, for a player who won, their own payout counting up.' },
  { key: 'bonusProgress', label: 'Bonus unlock bar', where: 'Wallet › General wallet',
    what: "How much of the referral bonus's play requirement is done, as a bar." },
  { key: 'promoCards', label: 'Promo cards', where: 'Board side columns (laptop); a swipeable banner under the header (phone, tablet)',
    what: 'The cards published under Content › Page Slides › Home promo cards, each opening its own link. Off, or with none published, the side columns show the built-in artwork instead.' },
];

export const PlayerScreenSettings: React.FC = () => {
  const [form, setForm] = useState<BoardExtras>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res: any = await system.getConfig();
        if (res?.success && res.data?.boardExtras) setForm({ ...DEFAULTS, ...res.data.boardExtras });
        else setError(res?.message || 'Could not load the player screen settings');
      } catch (e: any) {
        setError(e?.message || 'Could not load the player screen settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res: any = await system.updateConfig({ boardExtras: form });
      if (!res?.success) throw new Error(res?.message || 'Save failed');
      toast.success('Saved. Open player apps update now.');
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="card p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="card p-5 space-y-1">
        <h2 className="text-lg font-semibold">Player screen extras</h2>
        <p className="text-sm text-gray-400">
          Each switch shows or hides one piece of the player app. Every figure they show is the player's own or
          already public; nothing here invents activity.
        </p>
      </div>

      <div className="card divide-y divide-dark-700">
        {SWITCHES.map(sw => (
          <div key={sw.key} className="p-5 flex items-start gap-4">
            <input
              id={`extra-${sw.key}`}
              type="checkbox"
              className="mt-1"
              checked={form[sw.key]}
              onChange={(e) => setForm({ ...form, [sw.key]: e.target.checked })}
            />
            <div className="flex-1 min-w-0">
              <label htmlFor={`extra-${sw.key}`} className="label mb-0 cursor-pointer">{sw.label}</label>
              <div className="text-xs text-gray-500">{sw.where}</div>
              <p className="text-sm text-gray-400 mt-1">{sw.what}</p>
              {sw.key === 'urgencyChips' && (
                <div className="mt-3 max-w-xs">
                  <label className="label" htmlFor="closing-warn-seconds">Closing warning (seconds before bets close)</label>
                  <input
                    id="closing-warn-seconds"
                    type="number" min={0} max={120} step={1}
                    className="input"
                    disabled={!form.urgencyChips}
                    value={form.closingWarnSeconds}
                    onChange={(e) => setForm({ ...form, closingWarnSeconds: Math.min(120, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    0 to 120. The timer turns amber at twice this and red at this, when the chip appears. 0 = no closing chip.
                  </p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
      <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
};

export default PlayerScreenSettings;
