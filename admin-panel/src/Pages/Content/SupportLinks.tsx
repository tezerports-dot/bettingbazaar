// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Support Links — the channels and pages a player is pointed at.
 *
 * ── This screen could not save anything. At all. ───────────────────────────
 * It kept its own hand-written list of ten fields, and that list disagreed with
 * `SUPPORT_LINKS_SPEC` in BOTH directions:
 *
 *   offered here, never declared   facebook · twitter · supportHours · responseTime
 *   declared, never offered here   telegramUsername · telegramGroupUrl ·
 *                                  telegramChannelUrl · helpCenterUrl ·
 *                                  termsUrl · privacyUrl
 *
 * The PUT is one patch validated as a whole, so the first undeclared key
 * refuses the ENTIRE save. Driven in a browser: typing a support email and
 * pressing Save answered 400 with
 *
 *     config: refusing to write undeclared setting 'facebook'
 *
 * — about a field the admin never touched, while the email they DID type was
 * discarded with it. Every support channel a player sees was unreachable, for
 * as long as this screen has existed, and the message blamed something the
 * operator could do nothing about (§32 S14).
 *
 * ── The fix is to stop keeping a second list ───────────────────────────────
 * §2 already says this about `SYSTEM_CONFIG_SPEC`: the thing that DECLARES a
 * setting is what makes it editable, and every other list is a copy that will
 * drift. A panel cannot import the backend spec (§15), but it does not need to:
 * the GET returns the document, and the document's own keys ARE the spec's,
 * because the repository builds it from the spec.
 *
 * So the form renders one input per key the SERVER sent, and sends back only
 * keys the server sent. A field added to the spec appears here with no edit; a
 * field removed disappears; and an undeclared key cannot be submitted, because
 * there is nowhere for one to come from. `FIELDS` below is presentation only —
 * a label, a type and a placeholder — and a key it does not know still renders,
 * under a humanised version of its own name, rather than going invisible.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Save, Mail, Link2 } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

/** Keys the document carries that are NOT settings — metadata from the row. */
const NOT_A_SETTING = new Set(['key', 'version', 'updatedAt', 'updatedBy', '_id', 'id']);

type Shape = { label: string; type?: string; ph?: string; group: 'contact' | 'social' | 'pages' };

/**
 * Presentation for the keys we know about. NOT the source of truth for WHICH
 * keys exist — that is the document. A key missing from here still renders.
 */
const FIELDS: Record<string, Shape> = {
  email:              { label: 'Email',              type: 'email', ph: 'support@bettingbazaar.com', group: 'contact' },
  phone:              { label: 'Phone',              type: 'tel',   ph: '+91 98765 43210',           group: 'contact' },
  whatsapp:           { label: 'WhatsApp',           type: 'tel',   ph: '+91 98765 43210',           group: 'contact' },
  telegram:           { label: 'Telegram (legacy)',                 ph: '@bettingbazaar',            group: 'contact' },
  telegramUsername:   { label: 'Telegram username',                 ph: 'bettingbazaar_support',     group: 'contact' },
  telegramGroupUrl:   { label: 'Telegram group',     type: 'url',   ph: 'https://t.me/…',            group: 'social'  },
  telegramChannelUrl: { label: 'Telegram channel',   type: 'url',   ph: 'https://t.me/…',            group: 'social'  },
  instagram:          { label: 'Instagram',          type: 'url',   ph: 'https://instagram.com/…',   group: 'social'  },
  youtube:            { label: 'YouTube',            type: 'url',   ph: 'https://youtube.com/@…',    group: 'social'  },
  helpCenterUrl:      { label: 'Help centre',        type: 'url',   ph: 'https://…/help',            group: 'pages'   },
  termsUrl:           { label: 'Terms & conditions', type: 'url',   ph: 'https://…/terms',           group: 'pages'   },
  privacyUrl:         { label: 'Privacy policy',     type: 'url',   ph: 'https://…/privacy',         group: 'pages'   },
};

const humanise = (key: string) =>
  key.replace(/Url$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

const GROUPS: { id: Shape['group']; title: string; blurb: string }[] = [
  { id: 'contact', title: 'Contact', blurb: 'How a player reaches a human.' },
  { id: 'social',  title: 'Channels', blurb: 'Where the platform posts.' },
  { id: 'pages',   title: 'Pages', blurb: 'Read from the player panel — Profile links to these, and a blank one is HIDDEN there rather than shown as a dead row.' },
];

export const SupportLinks: React.FC = () => {
  const [form, setForm] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadLinks = async () => {
    setIsLoading(true);
    try {
      const response = await api.content.getSupportLinks();
      const doc = (response as any)?.data ?? {};
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc)) {
        if (NOT_A_SETTING.has(k)) continue;
        if (typeof v !== 'string') continue;   // the spec declares these as strings
        next[k] = v;
      }
      setForm(next);
    } catch {
      toast.error('Failed to load support links');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadLinks(); }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Only what the server told us exists. There is no other source, so an
      // undeclared key cannot be constructed here.
      await api.content.updateSupportLinks(form);
      toast.success('Support links updated');
      loadLinks();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update support links');
    } finally {
      setIsSaving(false);
    }
  };

  const keys = useMemo(() => Object.keys(form), [form]);
  const grouped = useMemo(() => GROUPS.map((g) => ({
    ...g,
    keys: keys.filter((k) => (FIELDS[k]?.group ?? 'contact') === g.id),
  })).filter((g) => g.keys.length), [keys]);

  const filled = keys.filter((k) => form[k]?.trim());

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="om-fade space-y-6">
      {!keys.length && (
        <p className="card text-sm text-amber-400" role="alert">
          The server returned no settings for this document. Nothing can be edited until it does.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {grouped.map((group) => (
          <div className="card" key={group.id}>
            <h3 className="text-lg font-semibold mb-1 flex items-center">
              {group.id === 'pages' ? <Link2 className="mr-2" size={20} /> : <Mail className="mr-2" size={20} />}
              {group.title}
            </h3>
            <p className="text-xs text-gray-500 mb-4">{group.blurb}</p>
            <div className="space-y-4">
              {group.keys.map((key) => {
                const f = FIELDS[key];
                return (
                  <div key={key}>
                    <label className="label" htmlFor={`sl-${key}`}>{f?.label ?? humanise(key)}</label>
                    <input
                      id={`sl-${key}`}
                      type={f?.type ?? 'text'}
                      value={form[key] ?? ''}
                      onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="input"
                      placeholder={f?.ph ?? ''}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <button onClick={handleSave} disabled={isSaving || !keys.length} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <Save size={16} /> {isSaving ? 'Saving…' : 'Save support links'}
        </button>
        <span className="text-xs text-gray-500">
          {filled.length} of {keys.length} set — a blank one is simply not shown to players.
        </span>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold mb-4">What a player will see</h3>
        {filled.length ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {filled.map((key) => (
              <div key={key} className="text-center p-3 bg-dark-700 rounded-lg">
                <p className="text-sm text-gray-300">{FIELDS[key]?.label ?? humanise(key)}</p>
                <p className="text-xs text-gray-500 mt-1 break-all">{form[key]}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-gray-500 py-4">Nothing configured yet — players see no support channels.</p>
        )}
      </div>
    </div>
  );
};
