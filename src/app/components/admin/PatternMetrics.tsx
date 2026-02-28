import { useState } from 'react';
import { User } from '../../lib/auth';
import { dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Badge } from '../ui/badge';
import { toast } from 'sonner';
import { TrendingUp, AlertTriangle, Users, Flag, Clock, BarChart } from 'lucide-react';

interface PatternMetricsProps {
  allUsers: User[];
}

interface EmployeeRisk {
  userId: string;
  userName: string;
  totalFlags: number;
  flagRate: number;
  riskLevel: 'high' | 'medium' | 'low';
}

export function PatternMetrics({ allUsers }: PatternMetricsProps) {
  const [period, setPeriod] = useState<string>('30');
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const analyzePatterns = async () => {
    setLoading(true);
    try {
      const days = parseInt(period);
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - days);

      const allEntries = await dbService.getAllTimeEntries();
      const filteredEntries = allEntries.filter(entry => {
        const entryDate = new Date(entry.date);
        return entryDate >= startDate && entryDate <= endDate && entry.complete;
      });

      // Summary metrics
      const totalEntries = filteredEntries.length;
      const flaggedEntries = filteredEntries.filter(e => e.flags && e.flags.length > 0).length;
      const flaggedPercentage = totalEntries > 0 ? (flaggedEntries / totalEntries) * 100 : 0;
      const activeEmployees = new Set(filteredEntries.map(e => e.userId)).size;

      // Flag distribution
      const flagCounts: Record<string, number> = {};
      filteredEntries.forEach(entry => {
        entry.flags?.forEach(flag => {
          flagCounts[flag] = (flagCounts[flag] || 0) + 1;
        });
      });

      const flagDistribution = Object.entries(flagCounts)
        .map(([name, value]) => ({
          name: name.replace(/_/g, ' '),
          value,
        }))
        .sort((a, b) => b.value - a.value);

      // Employee risk ranking
      const employeeStats: Map<string, { total: number; flagged: number }> = new Map();
      filteredEntries.forEach(entry => {
        const stats = employeeStats.get(entry.userId) || { total: 0, flagged: 0 };
        stats.total += 1;
        if (entry.flags && entry.flags.length > 0) {
          stats.flagged += entry.flags.length;
        }
        employeeStats.set(entry.userId, stats);
      });

      const employeeRisks: EmployeeRisk[] = Array.from(employeeStats.entries())
        .map(([userId, stats]) => {
          const userName = allUsers.find(u => u.uid === userId)?.name || 'Unknown';
          const flagRate = (stats.flagged / stats.total) * 100;
          let riskLevel: EmployeeRisk['riskLevel'] = 'low';
          if (flagRate > 30) riskLevel = 'high';
          else if (flagRate > 15) riskLevel = 'medium';

          return {
            userId,
            userName,
            totalFlags: stats.flagged,
            flagRate,
            riskLevel,
          };
        })
        .sort((a, b) => b.flagRate - a.flagRate);

      // Key insights
      const insights: string[] = [];
      if (flaggedPercentage > 25) {
        insights.push(`High flag rate: ${flaggedPercentage.toFixed(1)}% of entries are flagged`);
      }
      if (flagCounts.very_long_day && flagCounts.very_long_day > totalEntries * 0.1) {
        insights.push('Frequent overtime detected - consider workload review');
      }
      if (flagCounts.short_lunch && flagCounts.short_lunch > totalEntries * 0.1) {
        insights.push('Many employees taking short lunches - ensure compliance with break policies');
      }
      if (employeeRisks.filter(e => e.riskLevel === 'high').length > 0) {
        insights.push(`${employeeRisks.filter(e => e.riskLevel === 'high').length} employees flagged as high risk`);
      }
      if (insights.length === 0) {
        insights.push('No major issues detected - time entries look good!');
      }

      setMetrics({
        summary: {
          totalEntries,
          flaggedEntries,
          flaggedPercentage,
          activeEmployees,
        },
        flagDistribution,
        employeeRisks,
        insights,
      });

      toast.success('Analysis complete');
    } catch (error) {
      toast.error('Failed to analyze patterns');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Analysis Setup */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart className="size-4" />
            Pattern Analysis
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Analysis Period</Label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="14">Last 14 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="60">Last 60 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={analyzePatterns} disabled={loading} className="h-10 bg-blue-600 hover:bg-blue-700">
              <TrendingUp className="size-4 mr-2" />
              {loading ? 'Analyzing...' : 'Analyze'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {metrics && (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card className="border-2 border-blue-100 bg-gradient-to-br from-white to-blue-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-100 p-2.5 rounded-lg">
                    <Clock className="size-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">Entries</p>
                    <p className="text-2xl font-bold text-slate-900">{metrics.summary.totalEntries}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-amber-100 bg-gradient-to-br from-white to-amber-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-100 p-2.5 rounded-lg">
                    <Flag className="size-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">Flagged</p>
                    <p className="text-2xl font-bold text-slate-900">{metrics.summary.flaggedEntries}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-orange-100 bg-gradient-to-br from-white to-orange-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-orange-100 p-2.5 rounded-lg">
                    <TrendingUp className="size-5 text-orange-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">Flag Rate</p>
                    <p className="text-2xl font-bold text-slate-900">{metrics.summary.flaggedPercentage.toFixed(1)}%</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-blue-100 bg-gradient-to-br from-white to-blue-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-100 p-2.5 rounded-lg">
                    <Users className="size-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">Active</p>
                    <p className="text-2xl font-bold text-slate-900">{metrics.summary.activeEmployees}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Insights */}
          <Card className="border-2 border-blue-200 bg-blue-50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-blue-900">
                <AlertTriangle className="size-4" />
                Key Insights
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {metrics.insights.map((insight: string, i: number) => (
                  <li key={i} className="text-sm text-blue-900 flex items-start gap-2">
                    <span className="text-blue-600 mt-0.5">•</span>
                    <span>{insight}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* Flag Distribution */}
          {metrics.flagDistribution.length > 0 && (
            <Card className="border-2 border-slate-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Flag className="size-4" />
                  Flag Distribution
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {metrics.flagDistribution.map((item: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-2 bg-slate-50 rounded border border-slate-200">
                      <span className="text-sm font-medium text-slate-700 capitalize">{item.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-amber-500" 
                            style={{ width: `${(item.value / metrics.summary.totalEntries) * 100}%` }}
                          />
                        </div>
                        <span className="text-sm font-bold text-amber-600 min-w-[3rem] text-right">{item.value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Employee Risk Ranking */}
          <Card className="border-2 border-slate-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="size-4" />
                Employee Risk Analysis
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {metrics.employeeRisks.map((emp: EmployeeRisk) => (
                  <div key={emp.userId} className="flex items-center justify-between p-3 bg-slate-50 rounded border border-slate-200">
                    <div className="flex-1">
                      <p className="font-semibold text-sm text-slate-900">{emp.userName}</p>
                      <p className="text-xs text-slate-500">{emp.totalFlags} flags</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-slate-900">{emp.flagRate.toFixed(1)}%</span>
                      <Badge 
                        variant={emp.riskLevel === 'high' ? 'destructive' : emp.riskLevel === 'medium' ? 'default' : 'secondary'}
                        className={`
                          ${emp.riskLevel === 'high' ? 'bg-red-500' : ''}
                          ${emp.riskLevel === 'medium' ? 'bg-amber-500' : ''}
                          ${emp.riskLevel === 'low' ? 'bg-green-500' : ''}
                        `}
                      >
                        {emp.riskLevel}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Empty State */}
      {!metrics && !loading && (
        <Card className="border-2 border-dashed border-slate-300">
          <CardContent className="py-16 text-center">
            <div className="bg-slate-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <BarChart className="size-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">No Analysis Yet</h3>
            <p className="text-sm text-slate-500">Select a period and click "Analyze" to see insights</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
