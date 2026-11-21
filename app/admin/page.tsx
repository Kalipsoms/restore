import type { Metadata } from 'next';
import { Admin } from './panel';
import './admin.css';

export const metadata: Metadata = { title: 'Админка ReStore', robots: { index: false, follow: false } };

export default function AdminPage() {
  return <Admin />;
}
