/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// AISmartSkirmishPlayer.h
// A skirmish opponent that reacts to what it sees.
//
// WHAT THIS REPLACES
//
// AIPlayer::selectTeamToBuild() finds every buildable team, keeps those at the
// highest script-authored production priority, and then picks one with
// GameLogicRandomValue(). That is the entirety of the stock strategic layer --
// it never consults the game state, so the opponent fields the same army
// whether you come at it with tanks, aircraft, or nothing at all.
//
// This subclass keeps the designer's priority as a prior and adds a scoring
// pass on top of it, informed by a SkirmishEnemyModel that only knows what it
// has legitimately seen. The intent is an opponent that is hard because it
// responds, not because it gets a resource handicap.
//
// Everything below the strategic layer -- pathfinding, unit state machines,
// group movement, targeting -- is inherited untouched.

#pragma once

#ifndef _AI_SMART_SKIRMISH_PLAYER_H_
#define _AI_SMART_SKIRMISH_PLAYER_H_

#include "Common/GameMemory.h"

// These must precede AISkirmishPlayer.h. AIPlayer.h and AISkirmishPlayer.h use
// all three in member declarations but rely on the including translation unit
// having already declared them -- AISkirmishPlayer.cpp gets away with it by
// including Common/Team.h and friends first. Declaring them here keeps this
// header self-contained instead of imposing an include order on every user.
class TeamPrototype;
class SpecialPowerTemplate;
class Waypoint;

#include "GameLogic/AISkirmishPlayer.h"
#include "GameLogic/SkirmishEnemyModel.h"

/**
 * Skirmish AI with an enemy model and counter-composition scoring.
 */
class AISmartSkirmishPlayer : public AISkirmishPlayer
{
	MEMORY_POOL_GLUE_WITH_USERLOOKUP_CREATE( AISmartSkirmishPlayer, "AISmartSkirmishPlayer" )

public:

	AISmartSkirmishPlayer( Player *p );

	/// Tick the enemy model, then run the inherited strategic update.
	virtual void update( void ) override;

	/// Clear accumulated knowledge when a new map loads.
	virtual void newMap( void ) override;

	/// Read-only access, for debug overlays and for a future strategic layer.
	const SkirmishEnemyModel *getEnemyModel( void ) const { return &m_enemyModel; }

protected:

	/// Scored replacement for the stock random pick.
	virtual Bool selectTeamToBuild( void ) override;

	/**
		Rate how badly we want this team right now.

		Higher is better. Returns a value comparable across prototypes; the
		production priority authored in the map is folded in as a baseline so
		designer intent still carries weight on scripted maps.
	*/
	virtual Real scoreTeam( TeamPrototype *proto );

	/// Does any unit in this team carry a weapon that can engage aircraft?
	static Bool teamCanEngageAir( TeamPrototype *proto );

	/// Does this team consist mainly of foot units?
	static Bool teamIsMostlyInfantry( TeamPrototype *proto );

protected:

	SkirmishEnemyModel	m_enemyModel;
	UnsignedInt					m_lastModelUpdateFrame;		///< throttles the partition sweep
};

#endif // _AI_SMART_SKIRMISH_PLAYER_H_
