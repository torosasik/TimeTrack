import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { getInitials, getAvatarClasses } from '../../lib/avatar-utils';
import { cn } from './utils';

interface UserAvatarProps {
  name: string;
  image?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function UserAvatar({ name, image, className, size = 'md' }: UserAvatarProps) {
  const initials = getInitials(name);
  const { bg, text } = getAvatarClasses(name);

  const sizeClasses = {
    sm: 'size-8 text-xs',
    md: 'size-10 text-sm',
    lg: 'size-12 text-base',
  };

  return (
    <Avatar className={cn(sizeClasses[size], className)}>
      {image && <AvatarImage src={image} alt={name} />}
      <AvatarFallback className={cn(bg, text, 'font-semibold')}>
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
