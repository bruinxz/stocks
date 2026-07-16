import React from 'react';

export type CowMood =
  'confident' | 'curious' | 'surprised' | 'thinking' | 'sleepy' | 'working' | 'hopeful';

interface CowMascotProps {
  mood?: CowMood;
  className?: string;
}

/**
 * Original CSS mascot inspired by the round, expressive dairy-cow archetype.
 * Keeping the anatomy in markup lets every UI state share one recognisable
 * character while expressions remain lightweight and resolution-independent.
 */
export function CowMascot({ mood = 'confident', className = '' }: CowMascotProps) {
  return (
    <span className={`cow-mascot cow-mascot--${mood} ${className}`.trim()} aria-hidden="true">
      <span className="cow-mascot__ear cow-mascot__ear--left" />
      <span className="cow-mascot__ear cow-mascot__ear--right" />
      <span className="cow-mascot__horn cow-mascot__horn--left" />
      <span className="cow-mascot__horn cow-mascot__horn--right" />
      <span className="cow-mascot__head">
        <span className="cow-mascot__patch cow-mascot__patch--forehead" />
        <span className="cow-mascot__patch cow-mascot__patch--side" />
        <span className="cow-mascot__tuft">
          <i />
          <b />
        </span>
        <span className="cow-mascot__brow cow-mascot__brow--left" />
        <span className="cow-mascot__brow cow-mascot__brow--right" />
        <span className="cow-mascot__eye cow-mascot__eye--left">
          <i />
        </span>
        <span className="cow-mascot__eye cow-mascot__eye--right">
          <i />
        </span>
        <span className="cow-mascot__cheek cow-mascot__cheek--left" />
        <span className="cow-mascot__cheek cow-mascot__cheek--right" />
        <span className="cow-mascot__muzzle">
          <i />
          <b />
        </span>
      </span>
      <span className="cow-mascot__bell" />
      <span className="cow-mascot__body">
        <i />
      </span>
      <span className="cow-mascot__paw cow-mascot__paw--left" />
      <span className="cow-mascot__paw cow-mascot__paw--right" />
      <span className="cow-mascot__thought">?</span>
      <span className="cow-mascot__zzz">呼…</span>
      <span className="cow-mascot__spark">✦</span>
    </span>
  );
}
