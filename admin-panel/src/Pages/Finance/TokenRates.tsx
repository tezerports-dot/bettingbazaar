// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { DollarSign, TrendingUp, Save, RefreshCw, Info } from 'lucide-react';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import api from '../../services/api';
import type { TokenRates as TokenRatesType } from '../../types';
import toast from 'react-hot-toast';

export const TokenRates: React.FC = () => {
  const [rates, setRates] = useState<TokenRatesType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  
  const [buyRate, setBuyRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  
  const [exampleTokens, setExampleTokens] = useState('1000');

  useEffect(() => {
    loadCurrentRates();
  }, []);

  const loadCurrentRates = async () => {
    try {
      const response = await api.tokenRates.getCurrent();
      // Backend returns ApiResponse<TokenRates>: { success, data: TokenRates | null }
      // data is null if admin hasn't set rates yet
      if (response.success && response.data) {
        setRates(response.data);
        setBuyRate(response.data.buyRate.toString());
        setSellRate(response.data.sellRate.toString());
      }
    } catch (error) {
      toast.error('Failed to load token rates');
      console.error('Token rates error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    const buyRateNum = parseFloat(buyRate);
    const sellRateNum = parseFloat(sellRate);

    if (isNaN(buyRateNum) || isNaN(sellRateNum)) {
      toast.error('Please enter valid numbers');
      return;
    }

    if (buyRateNum <= 0 || sellRateNum <= 0) {
      toast.error('Rates must be positive numbers');
      return;
    }

    if (buyRateNum < sellRateNum) {
      toast.error('Buy rate cannot be lower than sell rate (that would mean a merchant loss)');
      return;
    }

    setIsSaving(true);
    try {
      const response = await api.tokenRates.update(buyRateNum, sellRateNum);
      if (response.success) {
        toast.success('Token rates updated successfully!');
        await loadCurrentRates();
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update rates');
    } finally {
      setIsSaving(false);
    }
  };

  const formatCurrency = (amount: number) => `₹${amount.toFixed(2)}`;

  const merchantProfit = parseFloat(buyRate) - parseFloat(sellRate);
  const exampleBuyAmount = parseFloat(exampleTokens) * parseFloat(buyRate || '0');
  const exampleSellAmount = parseFloat(exampleTokens) * parseFloat(sellRate || '0');
  const exampleMerchantProfit = parseFloat(exampleTokens) * merchantProfit;

  if (isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-2">Token Rate Management</h1>
        <p className="text-gray-400">Set BB token buy and sell prices</p>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
        <div className="flex items-start space-x-3">
          <Info className="text-blue-500 mt-0.5 flex-shrink-0" size={20} />
          <div className="text-sm">
            <p className="font-semibold text-blue-400 mb-1">How Token Pricing Works</p>
            <ul className="space-y-1 text-gray-300">
              <li>• <strong>Buy Rate:</strong> Price users pay per token</li>
              <li>• <strong>Sell Rate:</strong> Price users receive per token</li>
              <li>• <strong>Merchant Profit:</strong> Difference between buy and sell</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <DollarSign className="mr-2 text-gold-500" size={20} />
            Current Token Rates
          </h3>
          
          {rates && (
            <div className="space-y-4">
              <div className="p-4 bg-dark-700 rounded-lg">
                <p className="text-sm text-gray-400 mb-1">Buy Rate</p>
                <p className="text-3xl font-bold text-green-500">{formatCurrency(rates.buyRate)}</p>
              </div>

              <div className="p-4 bg-dark-700 rounded-lg">
                <p className="text-sm text-gray-400 mb-1">Sell Rate</p>
                <p className="text-3xl font-bold text-red-500">{formatCurrency(rates.sellRate)}</p>
              </div>

              <div className="p-4 bg-gold-500/10 border border-gold-500/30 rounded-lg">
                <p className="text-sm text-gray-400 mb-1">Merchant Profit</p>
                <p className="text-3xl font-bold text-gold-500">
                  {formatCurrency(rates.buyRate - rates.sellRate)}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <TrendingUp className="mr-2 text-gold-500" size={20} />
            Update Rates
          </h3>

          <div className="space-y-4">
            <div>
              <label className="label">Buy Rate (₹)</label>
              <input
                type="number"
                step="0.01"
                value={buyRate}
                onChange={(e) => setBuyRate(e.target.value)}
                className="input"
              />
            </div>

            <div>
              <label className="label">Sell Rate (₹)</label>
              <input
                type="number"
                step="0.01"
                value={sellRate}
                onChange={(e) => setSellRate(e.target.value)}
                className="input"
              />
            </div>

            {buyRate && sellRate && parseFloat(buyRate) > parseFloat(sellRate) && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3">
                <p className="text-sm text-gray-400 mb-1">Merchant Profit Preview</p>
                <p className="text-xl font-bold text-green-500">
                  {formatCurrency(merchantProfit)} per token
                </p>
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full btn-primary disabled:opacity-50 flex items-center justify-center"
            >
              {isSaving ? (
                <>
                  <RefreshCw className="mr-2 animate-spin" size={16} />
                  Updating...
                </>
              ) : (
                <>
                  <Save className="mr-2" size={16} />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Example Calculator</h3>
        
        <div className="space-y-4">
          <div>
            <label className="label">Number of Tokens</label>
            <input
              type="number"
              value={exampleTokens}
              onChange={(e) => setExampleTokens(e.target.value)}
              className="input"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-dark-700 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">User Buys {exampleTokens} Tokens</p>
              <p className="text-2xl font-bold text-green-500">
                ₹{exampleBuyAmount.toLocaleString()}
              </p>
            </div>

            <div className="p-4 bg-dark-700 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">User Sells {exampleTokens} Tokens</p>
              <p className="text-2xl font-bold text-red-500">
                ₹{exampleSellAmount.toLocaleString()}
              </p>
            </div>

            <div className="p-4 bg-gold-500/10 border border-gold-500/30 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">Merchant Profit</p>
              <p className="text-2xl font-bold text-gold-500">
                ₹{exampleMerchantProfit.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
