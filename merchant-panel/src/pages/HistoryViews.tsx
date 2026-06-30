// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Download, RefreshCw, Calendar } from 'lucide-react';
import toast from 'react-hot-toast';

interface VolumeData {
  date: string;
  deposits: number;
  withdrawals: number;
}

interface ProfitData {
  date: string;
  profit: number;
  orders: number;
}

interface CompletedOrderData {
  id: string;
  shortId: string;
  type: string;
  fiatAmount: number;
  tokenAmount: number;
  merchantProfit: number;
  user: string;
  date: string;
  status: string;
}

const HistoryViews: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'volume' | 'profit' | 'completed'>('volume');
  const [volumeData, setVolumeData] = useState<VolumeData[]>([]);
  const [profitData, setProfitData] = useState<ProfitData[]>([]);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [totals, setTotals] = useState({
    totalDeposits: 0,
    totalWithdrawals: 0,
    totalProfit: 0,
    totalOrders: 0,
    totalVolume: 0,
  });

  useEffect(() => {
    loadHistoryData();
  }, []);

  const loadHistoryData = async () => {
    try {
      setLoading(true);
      
      // Get ALL completed orders from backend
      const ordersData = await api.getOrders({ limit: 1000 });
      const allOrders = ordersData.orders;
      
      // Filter for completed/paid orders only (REAL completed transactions)
      const completed = allOrders.filter(order => 
        order.status === 'COMPLETED' || order.status === 'PAID'
      );

      // Process REAL volume data from orders (group by date)
      const volumeByDate: { [key: string]: VolumeData } = {};
      
      completed.forEach(order => {
        const date = new Date(order.createdAt).toLocaleDateString('en-IN');
        if (!volumeByDate[date]) {
          volumeByDate[date] = { date, deposits: 0, withdrawals: 0 };
        }
        
        // Use REAL fiatAmount from backend
        const fiatAmount = order.fiatAmount || order.amount || 0;
        
        if (order.type === 'DEPOSIT') {
          volumeByDate[date].deposits += fiatAmount;
        } else if (order.type === 'WITHDRAWAL') {
          volumeByDate[date].withdrawals += fiatAmount;
        }
      });

      const volumeArray = Object.values(volumeByDate)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-7); // Last 7 days
      setVolumeData(volumeArray);

      // Process REAL profit data from orders using merchantProfit field
      const profitByDate: { [key: string]: ProfitData } = {};
      
      completed.forEach(order => {
        const date = new Date(order.completedAt || order.createdAt).toLocaleDateString('en-IN');
        if (!profitByDate[date]) {
          profitByDate[date] = { date, profit: 0, orders: 0 };
        }
        
        // Use REAL merchantProfit from backend (NOT calculated 2%)
        const profit = order.merchantProfit || 0;
        profitByDate[date].profit += profit;
        profitByDate[date].orders += 1;
      });

      const profitArray = Object.values(profitByDate)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-7); // Last 7 days
      setProfitData(profitArray);

      // Set completed orders for table (last 50 with REAL data)
      const ordersForTable: CompletedOrderData[] = completed
        .slice(0, 50)
        .map(order => ({
          id: order.id || order._id || '',
          shortId: order.shortId || order.orderId || order.id || '',
          type: order.type,
          fiatAmount: order.fiatAmount || order.amount || 0,
          tokenAmount: order.tokenAmount || order.bbTokenAmount || 0,
          merchantProfit: order.merchantProfit || 0, // REAL profit from backend
          user: order.user?.username || (typeof order.userId === 'object' ? order.userId.username : 'Unknown') || 'Unknown',
          date: new Date(order.createdAt).toLocaleString('en-IN'),
          status: order.status,
        }));
      setCompletedOrders(ordersForTable);

      // Calculate REAL totals from backend data
      const totalDeposits = completed
        .filter(o => o.type === 'DEPOSIT')
        .reduce((sum, o) => sum + (o.fiatAmount || o.amount || 0), 0);
      
      const totalWithdrawals = completed
        .filter(o => o.type === 'WITHDRAWAL')
        .reduce((sum, o) => sum + (o.fiatAmount || o.amount || 0), 0);
      
      // Use REAL merchantProfit from backend
      const totalProfit = completed.reduce((sum, o) => sum + (o.merchantProfit || 0), 0);

      setTotals({
        totalDeposits,
        totalWithdrawals,
        totalProfit,
        totalOrders: completed.length,
        totalVolume: totalDeposits + totalWithdrawals,
      });

    } catch (error) {
      console.error('Failed to load history:', error);
      toast.error('Failed to load history data');
    } finally {
      setLoading(false);
    }
  };

  const handleExportData = () => {
    let data: any = [];
    let filename = '';
    
    switch (activeTab) {
      case 'volume':
        data = volumeData;
        filename = 'volume-data.csv';
        break;
      case 'profit':
        data = profitData;
        filename = 'profit-data.csv';
        break;
      case 'completed':
        data = completedOrders;
        filename = 'completed-orders.csv';
        break;
    }

    if (data.length === 0) {
      toast.error('No data to export');
      return;
    }

    // Convert to CSV
    const headers = Object.keys(data[0]).join(',');
    const rows = data.map((row: any) => Object.values(row).join(',')).join('\n');
    const csv = `${headers}\n${rows}`;

    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
    
    toast.success('Data exported successfully');
  };

  const renderTabContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading history...</p>
          </div>
        </div>
      );
    }

    switch (activeTab) {
      case 'volume':
        return (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Transaction Volume (Last 7 Days)</h3>
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <Calendar className="h-4 w-4" />
                  <span>{volumeData.length} days of REAL data</span>
                </div>
              </div>
              
              {volumeData.length === 0 ? (
                <div className="py-12 text-center text-gray-500">
                  No transaction data available yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={volumeData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip formatter={(value) => `₹${Number(value).toLocaleString('en-IN')}`} />
                    <Legend />
                    <Bar dataKey="deposits" fill="#10b981" name="Deposits (₹)" />
                    <Bar dataKey="withdrawals" fill="#ef4444" name="Withdrawals (₹)" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Summary Cards with REAL totals */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-green-50 p-6 rounded-lg border border-green-200">
                <p className="text-sm text-gray-600 mb-1">Total Deposits</p>
                <p className="text-3xl font-bold text-green-600">
                  ₹{totals.totalDeposits.toLocaleString('en-IN')}
                </p>
                <p className="text-xs text-gray-500 mt-1">All time (REAL from DB)</p>
              </div>
              <div className="bg-red-50 p-6 rounded-lg border border-red-200">
                <p className="text-sm text-gray-600 mb-1">Total Withdrawals</p>
                <p className="text-3xl font-bold text-red-600">
                  ₹{totals.totalWithdrawals.toLocaleString('en-IN')}
                </p>
                <p className="text-xs text-gray-500 mt-1">All time (REAL from DB)</p>
              </div>
              <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
                <p className="text-sm text-gray-600 mb-1">Total Volume</p>
                <p className="text-3xl font-bold text-blue-600">
                  ₹{totals.totalVolume.toLocaleString('en-IN')}
                </p>
                <p className="text-xs text-gray-500 mt-1">{totals.totalOrders} orders</p>
              </div>
            </div>
          </div>
        );

      case 'profit':
        return (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
              <h3 className="text-lg font-semibold mb-4">Daily Profit & Orders (Last 7 Days) - REAL merchantProfit</h3>
              
              {profitData.length === 0 ? (
                <div className="py-12 text-center text-gray-500">
                  No profit data available yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={profitData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" />
                    <Tooltip />
                    <Legend />
                    <Line 
                      yAxisId="left"
                      type="monotone" 
                      dataKey="profit" 
                      stroke="#10b981" 
                      name="Profit (₹) - REAL from Backend" 
                      strokeWidth={2}
                    />
                    <Line 
                      yAxisId="right"
                      type="monotone" 
                      dataKey="orders" 
                      stroke="#3b82f6" 
                      name="Orders" 
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Profit Summary with REAL merchantProfit */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-green-50 p-6 rounded-lg border border-green-200">
                <p className="text-sm text-gray-600 mb-1">Total Earnings (merchantProfit)</p>
                <p className="text-3xl font-bold text-green-600">
                  ₹{totals.totalProfit.toFixed(2)}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  From {totals.totalOrders} orders (REAL from Backend)
                </p>
              </div>
              <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
                <p className="text-sm text-gray-600 mb-1">Average Per Order</p>
                <p className="text-3xl font-bold text-blue-600">
                  ₹{totals.totalOrders > 0 ? (totals.totalProfit / totals.totalOrders).toFixed(2) : '0.00'}
                </p>
                <p className="text-xs text-gray-500 mt-1">Real profit per transaction</p>
              </div>
            </div>
          </div>
        );

      case 'completed':
        return (
          <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
            {completedOrders.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-gray-500 text-lg">No completed orders found</p>
                <p className="text-gray-400 text-sm mt-2">Completed orders will appear here</p>
              </div>
            ) : (
              <>
                <div className="p-4 bg-gray-50 border-b">
                  <p className="text-sm text-gray-600">
                    Showing {completedOrders.length} most recent completed orders (REAL from Database)
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Order ID
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Type
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Amount (₹)
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Tokens
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Your Profit (REAL)
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          User
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Date
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {completedOrders.map((order) => (
                        <tr key={order.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            {order.shortId}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                order.type === 'DEPOSIT'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {order.type}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">
                            ₹{order.fiatAmount.toLocaleString('en-IN')}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {order.tokenAmount.toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600 font-bold">
                            ₹{order.merchantProfit.toFixed(2)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {order.user}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {order.date}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Transaction History</h1>
          <p className="text-gray-600 mt-1">All data is REAL from your database</p>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={loadHistoryData}
            className="flex items-center space-x-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleExportData}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Download className="h-4 w-4" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab('volume')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'volume'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Volume (REAL)
          </button>
          <button
            onClick={() => setActiveTab('profit')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'profit'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Profit (merchantProfit)
          </button>
          <button
            onClick={() => setActiveTab('completed')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'completed'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Completed Orders
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      {renderTabContent()}
    </div>
  );
};

export default HistoryViews;
