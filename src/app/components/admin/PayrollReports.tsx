import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { collection, getDocs, orderBy, query, where, doc, getDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import { FileText, Printer, Download, DollarSign, Clock, TrendingUp } from 'lucide-react';
import { generateCSV, downloadCSV } from '../../../services/exportService';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module
import { calculateBiweeklyOvertimeTotals, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations.js';

interface PayrollReportsProps {
  allUsers: User[];
}

interface PayrollSummary {
  userId: string;
  userName: string;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  totalHours: number;
  dailyEntries?: any[];
}

export function PayrollReports({ allUsers }: PayrollReportsProps) {
  const [selectedUserId, setSelectedUserId] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [report, setReport] = useState<PayrollSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [payrollSettings, setPayrollSettings] = useState({
    payroll_cycle_type: 'biweekly',
    weekly_start_day: 1,
    biweekly_start_date: '2024-01-01'
  });

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const snap = await getDoc(doc(db, 'systemSettings', 'payroll'));
        if (snap.exists()) {
          const data = snap.data();
          setPayrollSettings({
            payroll_cycle_type: data.payroll_cycle_type || 'biweekly',
            weekly_start_day: data.weekly_start_day ?? 1,
            biweekly_start_date: data.biweekly_start_date || '2024-01-01',
          });
        }
      } catch (err) {
        console.error('Failed to load payroll settings', err);
      }
    };
    loadSettings();
  }, []);

  const cycleType = payrollSettings.payroll_cycle_type;

  const setQuickPeriod = (preset: 'current' | 'last') => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (cycleType === 'weekly') {
      const day = today.getDay();
      const startDay = payrollSettings.weekly_start_day;
      const diff = day >= startDay ? day - startDay : 7 - (startDay - day);

      const currentStart = new Date(today);
      currentStart.setDate(today.getDate() - diff);
      const currentEnd = new Date(currentStart);
      currentEnd.setDate(currentStart.getDate() + 6);

      if (preset === 'current') {
        setStartDate(currentStart.toISOString().split('T')[0]);
        setEndDate(currentEnd.toISOString().split('T')[0]);
      } else {
        const lastStart = new Date(currentStart);
        lastStart.setDate(lastStart.getDate() - 7);
        const lastEnd = new Date(lastStart);
        lastEnd.setDate(lastStart.getDate() + 6);
        setStartDate(lastStart.toISOString().split('T')[0]);
        setEndDate(lastEnd.toISOString().split('T')[0]);
      }
    } else if (cycleType === 'biweekly' || cycleType === 'custom') {
      // Use anchor date to determine current biweekly block
      let anchorStr = payrollSettings.biweekly_start_date;
      if (!anchorStr) anchorStr = '2024-01-01';
      const anchor = new Date(anchorStr + 'T00:00:00');

      const diffTime = today.getTime() - anchor.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      const cyclesPassed = Math.floor(diffDays / 14);
      const currentStart = new Date(anchor);
      currentStart.setDate(anchor.getDate() + (cyclesPassed * 14));
      const currentEnd = new Date(currentStart);
      currentEnd.setDate(currentStart.getDate() + 13);

      if (preset === 'current') {
        setStartDate(currentStart.toISOString().split('T')[0]);
        setEndDate(currentEnd.toISOString().split('T')[0]);
      } else {
        const lastStart = new Date(currentStart);
        lastStart.setDate(lastStart.getDate() - 14);
        const lastEnd = new Date(lastStart);
        lastEnd.setDate(lastStart.getDate() + 13);
        setStartDate(lastStart.toISOString().split('T')[0]);
        setEndDate(lastEnd.toISOString().split('T')[0]);
      }
    } else if (cycleType === 'monthly') {
      if (preset === 'current') {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        setStartDate(start.toISOString().split('T')[0]);
        setEndDate(end.toISOString().split('T')[0]);
      } else {
        const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth(), 0);
        setStartDate(start.toISOString().split('T')[0]);
        setEndDate(end.toISOString().split('T')[0]);
      }
    }
  };

  const generateReport = async () => {
    if (!startDate || !endDate) {
      toast.error('Please select start and end dates');
      return;
    }

    setLoading(true);
    try {
      // Pull entries from Firestore (same query pattern as the old app)
      const base = collection(db, 'timeEntries');
      const q =
        selectedUserId === 'all'
          ? query(base, where('workDate', '>=', startDate), where('workDate', '<=', endDate), orderBy('workDate', 'asc'))
          : query(
            base,
            where('userId', '==', selectedUserId),
            where('workDate', '>=', startDate),
            where('workDate', '<=', endDate),
            orderBy('workDate', 'asc')
          );

      const snap = await getDocs(q);
      const rawEntries = snap.docs
        .map(d => d.data() as any)
        .filter(e => e.dayComplete === true);

      // Group by employee and calculate biweekly overtime totals (California rules)
      const byUser = new Map<string, any[]>();
      rawEntries.forEach(e => {
        const uid = String(e.userId || '');
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid)!.push(e);
      });

      const summaries: PayrollSummary[] = [];
      for (const [userId, entries] of byUser.entries()) {
        const ot = calculateBiweeklyOvertimeTotals(entries, payrollSettings.weekly_start_day);
        summaries.push({
          userId,
          userName: allUsers.find(u => u.uid === userId)?.name || 'Unknown',
          regularHours: (ot.grandTotals.regularMinutes || 0) / 60,
          overtimeHours: (ot.grandTotals.otMinutes || 0) / 60,
          doubleTimeHours: (ot.grandTotals.doubleTimeMinutes || 0) / 60,
          totalHours: (ot.grandTotals.totalMinutes || 0) / 60,
          dailyEntries: ot.adjustedEntries.sort((a, b) => b.workDate.localeCompare(a.workDate))
        });
      }

      summaries.sort((a, b) => a.userName.localeCompare(b.userName));
      setReport(summaries);
      toast.success('Report generated');
    } catch (error) {
      toast.error('Failed to generate report');
    } finally {
      setLoading(false);
    }
  };

  const exportCSV = () => {
    if (!report) return;

    const headers = ['Employee', 'Regular Hours', 'Overtime (1.5x)', 'Double Time (2x)', 'Total Hours'];
    const rows = report.map(r => [
      r.userName,
      r.regularHours.toFixed(2),
      r.overtimeHours.toFixed(2),
      r.doubleTimeHours.toFixed(2),
      r.totalHours.toFixed(2),
    ]);

    const csvContent = generateCSV(headers, rows);
    downloadCSV(`payroll-report-${startDate}-to-${endDate}`, csvContent);
    toast.success('CSV exported');
  };

  const printReport = () => {
    window.print();
  };

  const totalRegular = report?.reduce((acc, r) => acc + r.regularHours, 0) || 0;
  const totalOvertime = report?.reduce((acc, r) => acc + r.overtimeHours, 0) || 0;
  const totalDouble = report?.reduce((acc, r) => acc + r.doubleTimeHours, 0) || 0;
  const grandTotal = report?.reduce((acc, r) => acc + r.totalHours, 0) || 0;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm mb-2">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          Payroll Reports
        </h2>
        <SectionHelp 
          title="Payroll Reports"
          description="Generates summary reports regarding accumulated aggregates across cycle nodes."
          sections={[
            { title: "Setup View", content: "Filter by User and Period thresholds to accumulate total intervals." },
            { title: "Details Breakdowns", content: "Click 'View Details' on card objects to expand precise timestamp rows grids." },
            { title: "Cycle Configuration", content: "Admin adjusts defaults cycle types in global System Settings." }
          ]}
        />
      </div>
      {/* Report Setup Card */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="size-4" />
            Payroll Report Setup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Employee</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Employees</SelectItem>
                  {allUsers.filter(u => u.role === 'employee').map(u => (
                    <SelectItem key={u.uid} value={u.uid}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-10"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setQuickPeriod('current')} className="h-8 text-xs">
              Current Cycle
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickPeriod('last')} className="h-8 text-xs">
              Last Cycle
            </Button>
          </div>

          <Button onClick={generateReport} disabled={loading} className="w-full h-10 bg-blue-600 hover:bg-blue-700">
            <FileText className="size-4 mr-2" />
            {loading ? 'Generating...' : 'Generate Report'}
          </Button>
        </CardContent>
      </Card>

      {/* Report Results */}
      {report && (
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
                    <p className="text-xs text-slate-600">Regular</p>
                    <p className="text-2xl font-bold text-slate-900">{totalRegular.toFixed(1)}</p>
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
                    <p className="text-xs text-slate-600">OT (1.5x)</p>
                    <p className="text-2xl font-bold text-slate-900">{totalOvertime.toFixed(1)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-red-100 bg-gradient-to-br from-white to-red-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-red-100 p-2.5 rounded-lg">
                    <TrendingUp className="size-5 text-red-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">DT (2x)</p>
                    <p className="text-2xl font-bold text-slate-900">{totalDouble.toFixed(1)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-2 border-green-100 bg-gradient-to-br from-white to-green-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="bg-green-100 p-2.5 rounded-lg">
                    <DollarSign className="size-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-600">Total</p>
                    <p className="text-2xl font-bold text-slate-900">{grandTotal.toFixed(1)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          <Card className="border-2 border-slate-200">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={printReport} className="h-10">
                  <Printer className="size-4 mr-2" />
                  Print
                </Button>
                <Button variant="outline" onClick={exportCSV} className="h-10">
                  <Download className="size-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Employee Cards - Mobile Friendly */}
          <div className="space-y-2">
            {report.map(summary => (
              <Card key={summary.userId} className="border-2 border-slate-200">
                <CardContent className="p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h3 className="font-semibold text-slate-900">{summary.userName}</h3>
                      <p className="text-xs text-slate-500">Total: {summary.totalHours.toFixed(2)} hours</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedUserId(expandedUserId === summary.userId ? null : summary.userId)}
                      className="h-8 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                    >
                      {expandedUserId === summary.userId ? 'Hide Details' : 'View Details'}
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <p className="text-xs text-slate-600 mb-0.5">Regular</p>
                      <p className="text-lg font-bold text-slate-900">{summary.regularHours.toFixed(1)}</p>
                    </div>
                    <div className="bg-orange-50 p-2 rounded border border-orange-200">
                      <p className="text-xs text-orange-700 mb-0.5">OT 1.5x</p>
                      <p className="text-lg font-bold text-orange-700">{summary.overtimeHours.toFixed(1)}</p>
                    </div>
                    <div className="bg-red-50 p-2 rounded border border-red-200">
                      <p className="text-xs text-red-700 mb-0.5">DT 2x</p>
                      <p className="text-lg font-bold text-red-700">{summary.doubleTimeHours.toFixed(1)}</p>
                    </div>
                  </div>

                  {expandedUserId === summary.userId && summary.dailyEntries && (
                    <div className="mt-4 pt-3 border-t border-slate-200 overflow-x-auto">
                      <p className="text-xs font-semibold text-slate-700 mb-2">Daily Breakdown</p>
                      <table className="w-full text-xs text-left text-slate-600">
                        <thead className="bg-slate-50 text-slate-700 font-semibold">
                          <tr>
                            <th className="p-1.5">Date</th>
                            <th className="p-1.5">In</th>
                            <th className="p-1.5">L.Out</th>
                            <th className="p-1.5">L.In</th>
                            <th className="p-1.5">Out</th>
                            <th className="p-1.5 text-right">Reg</th>
                            <th className="p-1.5 text-right">OT+DT</th>
                            <th className="p-1.5 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.dailyEntries.map((day: any) => (
                            <tr key={day.workDate} className="border-b border-slate-100 hover:bg-slate-50/50">
                              <td className="p-1.5 font-medium">{day.workDate.split('-').slice(1).join('/')}</td>
                              <td className="p-1.5">{day.clockInManual || '--'}</td>
                              <td className="p-1.5">{day.lunchOutManual || '--'}</td>
                              <td className="p-1.5">{day.lunchInManual || '--'}</td>
                              <td className="p-1.5">{day.clockOutManual || '--'}</td>
                              <td className="p-1.5 text-right">{((day.regularMinutes || 0) / 60).toFixed(1)}</td>
                              <td className="p-1.5 text-right">{(((day.otMinutes || 0) + (day.doubleTimeMinutes || 0)) / 60).toFixed(1)}</td>
                              <td className="p-1.5 text-right font-semibold">{((day.totalWorkMinutes || 0) / 60).toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}

            {/* Totals Card */}
            <Card className="border-2 border-blue-600 bg-blue-50">
              <CardContent className="p-4">
                <div className="mb-2">
                  <h3 className="font-bold text-blue-900">TOTALS</h3>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-white p-2 rounded border border-blue-200">
                    <p className="text-xs text-slate-600 mb-0.5">Regular</p>
                    <p className="text-lg font-bold text-slate-900">{totalRegular.toFixed(1)}</p>
                  </div>
                  <div className="bg-white p-2 rounded border border-blue-200">
                    <p className="text-xs text-orange-700 mb-0.5">OT 1.5x</p>
                    <p className="text-lg font-bold text-orange-700">{totalOvertime.toFixed(1)}</p>
                  </div>
                  <div className="bg-white p-2 rounded border border-blue-200">
                    <p className="text-xs text-red-700 mb-0.5">DT 2x</p>
                    <p className="text-lg font-bold text-red-700">{totalDouble.toFixed(1)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Info Card */}
          <Card className="border-2 border-blue-200 bg-blue-50">
            <CardContent className="p-4">
              <p className="text-sm font-semibold text-blue-900 mb-2">California Overtime Rules Applied</p>
              <div className="text-sm text-blue-800 space-y-1">
                <p>• <strong>Regular:</strong> First 8 hours per day, up to 40 per week</p>
                <p>• <strong>Overtime (1.5x):</strong> Hours 8-12 per day, or over 40 per week</p>
                <p>• <strong>Double Time (2x):</strong> Over 12 hours per day</p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
