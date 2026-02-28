import { cn } from './utils';

interface StatusDotProps {
  status: 'active' | 'inactive' | 'pending' | 'approved' | 'rejected' | 'complete' | 'incomplete';
  className?: string;
  showLabel?: boolean;
  label?: string;
}

export function StatusDot({ status, className, showLabel = false, label }: StatusDotProps) {
  const statusConfig = {
    active: {
      dotColor: 'bg-green-500',
      label: label || 'Active',
      textColor: 'text-green-700',
    },
    inactive: {
      dotColor: 'bg-gray-400',
      label: label || 'Inactive',
      textColor: 'text-gray-700',
    },
    pending: {
      dotColor: 'bg-amber-500',
      label: label || 'Pending',
      textColor: 'text-amber-700',
    },
    approved: {
      dotColor: 'bg-green-500',
      label: label || 'Approved',
      textColor: 'text-green-700',
    },
    rejected: {
      dotColor: 'bg-red-500',
      label: label || 'Rejected',
      textColor: 'text-red-700',
    },
    complete: {
      dotColor: 'bg-blue-500',
      label: label || 'Complete',
      textColor: 'text-blue-700',
    },
    incomplete: {
      dotColor: 'bg-orange-500',
      label: label || 'Incomplete',
      textColor: 'text-orange-700',
    },
  };

  const config = statusConfig[status];

  if (showLabel) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <span className={cn("size-2 rounded-full", config.dotColor)} />
        <span className={cn("text-sm font-medium", config.textColor)}>
          {config.label}
        </span>
      </div>
    );
  }

  return <span className={cn("size-2 rounded-full", config.dotColor, className)} />;
}
