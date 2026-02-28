import { Check } from 'lucide-react';
import { cn } from './utils';

interface Step {
  id: string;
  label: string;
  description?: string;
}

interface ProgressStepperProps {
  steps: Step[];
  currentStep: number;
  className?: string;
  orientation?: 'horizontal' | 'vertical';
}

export function ProgressStepper({ steps, currentStep, className, orientation = 'horizontal' }: ProgressStepperProps) {
  if (orientation === 'vertical') {
    return (
      <div className={cn("w-full space-y-4", className)}>
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isFuture = index > currentStep;

          return (
            <div key={step.id} className="flex items-start gap-3">
              {/* Step Circle */}
              <div
                className={cn(
                  "flex items-center justify-center size-8 rounded-full border-2 transition-all duration-300 flex-shrink-0",
                  isCompleted && "bg-primary border-primary text-primary-foreground",
                  isCurrent && "bg-primary border-primary text-primary-foreground ring-4 ring-primary/20",
                  isFuture && "bg-background border-muted-foreground/30 text-muted-foreground"
                )}
              >
                {isCompleted ? (
                  <Check className="size-4" />
                ) : (
                  <span className="text-xs font-semibold">{index + 1}</span>
                )}
              </div>

              {/* Step Content */}
              <div className="flex-1 pt-0.5">
                <p
                  className={cn(
                    "text-sm font-medium",
                    (isCompleted || isCurrent) && "text-foreground",
                    isFuture && "text-muted-foreground"
                  )}
                >
                  {step.label}
                </p>
                {step.description && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {step.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isFuture = index > currentStep;

          return (
            <div key={step.id} className="flex items-center flex-1">
              {/* Step Circle */}
              <div className="flex flex-col items-center relative">
                <div
                  className={cn(
                    "flex items-center justify-center size-8 sm:size-10 rounded-full border-2 transition-all duration-300",
                    isCompleted && "bg-primary border-primary text-primary-foreground",
                    isCurrent && "bg-primary border-primary text-primary-foreground ring-4 ring-primary/20",
                    isFuture && "bg-background border-muted-foreground/30 text-muted-foreground"
                  )}
                >
                  {isCompleted ? (
                    <Check className="size-4 sm:size-5" />
                  ) : (
                    <span className="text-xs sm:text-sm font-semibold">{index + 1}</span>
                  )}
                </div>
                <div className="mt-2 text-center">
                  <p
                    className={cn(
                      "text-xs font-medium whitespace-nowrap",
                      (isCompleted || isCurrent) && "text-foreground",
                      isFuture && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                      {step.description}
                    </p>
                  )}
                </div>
              </div>

              {/* Connector Line */}
              {index < steps.length - 1 && (
                <div className="flex-1 h-0.5 mx-1 sm:mx-2 mb-8">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      isCompleted && "bg-primary",
                      !isCompleted && "bg-muted-foreground/20"
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}