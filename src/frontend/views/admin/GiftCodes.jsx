import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function GiftCodes() {
  return <AdminPanelShell title={'Gift Codes'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="Gift Codes"><p>API binding: <code>/api/admin/giftcodes</code></p></VisualPage></AdminPanelShell>;
}
