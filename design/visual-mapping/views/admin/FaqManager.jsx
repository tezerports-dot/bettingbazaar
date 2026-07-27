import React from 'react';
import VisualPage from '../../components/VisualPage.jsx';
import AdminPanelShell from '../../layouts/AdminPanelShell.jsx';

export default function FaqManager() {
  return <AdminPanelShell title={'FAQ Manager'}><VisualPage eyebrow="ADMIN VISUAL MAPPING" title="FAQ Manager"><p>API binding: <code>/api/admin/content/faq</code></p></VisualPage></AdminPanelShell>;
}
